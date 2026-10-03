import type { Request } from "express";
import type { Address, Hex } from "viem";
import { env } from "../../../config/env.js";
import { AppError } from "../../../lib/errors.js";
import { ArcConfigError, operator } from "../client.js";
import {
  checkAuthorizationLocally,
  type Authorization,
} from "./authorization.js";
import { awaitSettlement, settlePayment, type SettlementOutcome } from "./facilitator.js";
import { buildRequirements, paymentRequiredBody, requirementsMatch, type PaymentRequirements, type ResourceInfo } from "./requirements.js";

/**
 * The bit of the x402 gate that both callers share: the browser's
 * prepare/complete pair and the standard `402`-then-retry path on `/download`.
 *
 * Keeping it in one place is what stops the two paths drifting apart on the
 * question that matters — who the money goes to, and for how much.
 */

type Game = { id: string; vaultAddress: string | null; title: string };

/**
 * Where this game's buyers pay.
 *
 * The game's own vault, always, once it has one. The fallback exists only for
 * games published before the Arc port; it is an address we control, so a sale
 * settled against it has *not* had its split enforced by a contract, and that is
 * exactly why it is a loud configuration error rather than a silent default.
 */
export function payToFor(game: Game): Address {
  if (game.vaultAddress) return game.vaultAddress as Address;
  if (env.ARC_FALLBACK_PAY_TO) return env.ARC_FALLBACK_PAY_TO as Address;
  throw new ArcConfigError(
    "ARC_FALLBACK_PAY_TO",
    `Game ${game.id} has no vault_address (it predates the Arc port) and there is no fallback payout ` +
      `address configured, so there is nowhere for a buyer to pay. Republish the game to deploy its vault.`,
  );
}

export function resourceInfoFor(req: Request, description: string): ResourceInfo {
  return {
    url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
    description,
    mimeType: "application/json",
  };
}

/** x402 sends the payload base64-encoded. `x-payment` is the older header name. */
export function readPaymentHeader(headers: Request["headers"]): string | undefined {
  const value = headers["payment-signature"] ?? headers["x-payment"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export type DecodedPayment = {
  accepted: unknown;
  authorization: Authorization;
  signature: Hex;
};

/**
 * Pull the authorization out of a `payment-signature` header.
 *
 * Everything in here is attacker-controlled, so nothing is trusted: the terms
 * are re-matched against ours in `settleFromHeader`, and the authorization's own
 * fields are checked against the price we computed, not against what the header
 * claims the price was.
 */
export function decodePaymentHeader(header: string): DecodedPayment {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new AppError(402, "PAYMENT_REQUIRED", "The payment header could not be read.");
  }

  const body = raw as { accepted?: unknown; payload?: { signature?: unknown; authorization?: Record<string, unknown> } };
  const payload = body.payload;
  const a = payload?.authorization;
  if (!a || typeof payload?.signature !== "string") {
    throw new AppError(402, "PAYMENT_REQUIRED", "The payment header carried no signed authorization.");
  }

  try {
    return {
      accepted: body.accepted,
      signature: payload.signature as Hex,
      authorization: {
        from: String(a.from) as Address,
        to: String(a.to) as Address,
        value: BigInt(String(a.value)),
        validAfter: BigInt(String(a.validAfter ?? 0)),
        validBefore: BigInt(String(a.validBefore)),
        nonce: String(a.nonce) as Hex,
      },
    };
  } catch {
    throw new AppError(402, "PAYMENT_REQUIRED", "The payment authorization was malformed.");
  }
}

export type GateTerms = { requirements: PaymentRequirements; resource: ResourceInfo; payTo: Address };

export function termsFor(req: Request, game: Game, owedUnits: number, description: string): GateTerms {
  const payTo = payToFor(game);
  return {
    requirements: buildRequirements(payTo, BigInt(owedUnits)),
    resource: resourceInfoFor(req, description),
    payTo,
  };
}

export const challengeBody = (terms: GateTerms) => paymentRequiredBody(terms.requirements, terms.resource);

export type SettledPayment = { transaction: Hex; payer: Address; amountUnits: number };

/**
 * Verify and settle a payment that arrived on a request, or throw a `402` whose
 * body says exactly what was wrong with it.
 *
 * `paymentId` is the idempotency key Circle scopes to our seller account:
 * retrying with the same one converges on the same payment instead of charging
 * twice, which matters because a timeout is explicitly not evidence of failure.
 */
export async function settleFromHeader(
  terms: GateTerms,
  payment: DecodedPayment,
  paymentId: string,
): Promise<SettledPayment> {
  // The claimed terms must be the terms we offered. Without this a client could
  // hand back its own `payTo` and have the authorization validated against that
  // rather than against the game's vault.
  if (!requirementsMatch(terms.requirements, payment.accepted)) {
    throw new AppError(402, "PAYMENT_REQUIRED", "The payment doesn't match this game's price.");
  }

  const local = await checkAuthorizationLocally(payment.authorization, payment.signature, {
    to: terms.payTo,
    units: BigInt(terms.requirements.amount),
  });
  if (!local.ok) {
    throw new AppError(402, "PAYMENT_REQUIRED", local.message, { reason: local.reason });
  }

  let outcome: SettlementOutcome = await settlePayment({
    requirements: terms.requirements,
    resource: terms.resource,
    authorization: payment.authorization,
    signature: payment.signature,
    paymentId,
  });
  outcome = await awaitSettlement(outcome, terms.payTo);

  if (outcome.status === "failed") {
    throw new AppError(402, "PAYMENT_REQUIRED", outcome.message, { reason: outcome.reason });
  }
  if (outcome.status === "pending") {
    // Never fulfil on pending — the transfer may still land, so this is a "come
    // back and we'll know", not a refusal. Circle reconciles it by paymentId.
    //
    // **409, not 202, and the status code is the whole point.** This used to
    // answer `202 Accepted`, which is honest about the state and actively
    // dangerous as a contract: 202 is a 2xx, so any client that checks
    // `response.ok` — ours did — treats the error envelope below as the
    // success payload and proceeds as though it had been handed the game,
    // with every field undefined. A caller's single most important question
    // here is "may I serve the resource", the answer is no, and only a 4xx
    // says that to a client that has never heard of this code.
    throw new AppError(
      409,
      "PAYMENT_PENDING",
      "The payment is still settling. Ask again with the same payment to pick up the outcome; it has not been charged twice.",
      { paymentId: outcome.paymentId },
    );
  }

  return {
    transaction: outcome.transaction,
    payer: outcome.payer,
    amountUnits: Number(outcome.amount),
  };
}

/**
 * Who the key belongs to, when the payer is an agent.
 *
 * An agent pays from its own wallet for the person who funded it, so the
 * GameKey has to land with that person. Honoured only when the address that
 * actually signed the payment is a known agent's, so an ordinary buyer sending
 * this header changes nothing about their own purchase.
 */
export async function ownerForPayment(
  req: Request,
  payer: Address,
  isAgentAddress: (address: Address) => Promise<boolean>,
): Promise<Address> {
  const override = req.headers["x-owner-address"] ?? req.headers["x-owner-account-id"];
  if (typeof override !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(override)) return payer;
  return (await isAgentAddress(payer)) ? (override as Address) : payer;
}

/** The operator's address, for the one case where a fallback payout is in play. */
export const operatorAddress = (): Address => operator().address;
