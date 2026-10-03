import { randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import { env } from "../../../config/env.js";
import { AppError } from "../../../lib/errors.js";
import {
  AUTHORIZATION_TTL_SECONDS,
  buildAuthorization,
  typedDataFor,
  type Authorization,
} from "./authorization.js";
import { buildGatewayAuthorization, gatewayTypedDataFor, type GatewayPaymentRequirements } from "./gateway.js";
import { encodePaymentHeader } from "./payer.js";
import type { PaymentRequirements, ResourceInfo } from "./requirements.js";

/**
 * The browser half of a purchase: prepare, sign, complete.
 *
 * The split exists because only the browser has authority over the buyer's own
 * wallet. Privy is right to refuse when a server asks to sign on someone's
 * behalf, and the alternative — asking every buyer to delegate their wallet to
 * the store before their first purchase — is standing permission to move their
 * money, a far larger thing to agree to than one game.
 *
 * What changed on Arc is *what* gets signed. On Hedera the server had to freeze
 * a transaction first, so the thing held between the two calls was a signed-once
 * transaction that expired in two minutes; a buyer who left the tab came back to
 * a payment that could no longer settle. Here it is an EIP-712 typed message
 * naming the vault, the amount and a deadline, valid for half an hour, and the
 * buyer's wallet shows them exactly that. The intent still exists, but only to
 * bind the signature to the price *we* quoted — so a client cannot sign its own
 * cheaper authorization and have it accepted.
 *
 * Settlement goes through our own x402-gated route over loopback rather than
 * calling the facilitator directly. That keeps exactly one settlement
 * implementation, and it means the gate a stranger's client meets is the same
 * gate our own browser meets.
 */

const downloadUrl = (gameId: string) => `http://127.0.0.1:${env.PORT}/api/games/${gameId}/download`;
const trialChunkUrl = (gameId: string) => `http://127.0.0.1:${env.PORT}/api/games/${gameId}/trial/chunks/settle`;

type Intent = {
  id: string;
  userId: string;
  gameId: string;
  kind: "purchase" | "trial_chunk";
  settleUrl: string;
  authorization: Authorization;
  /** A trial chunk's requirements are Gateway-shaped — see gate.ts vs gateway.ts. */
  requirements: PaymentRequirements | GatewayPaymentRequirements;
  resource: ResourceInfo;
  /** The buyer's bearer token, so the loopback call is made as them. */
  bearer?: string;
  expiresAt: number;
};

function isGatewayRequirements(r: Intent["requirements"]): r is GatewayPaymentRequirements {
  return r.extra.name === "GatewayWalletBatched";
}

const intents = new Map<string, Intent>();

/**
 * The intent outlives the authorization by a margin rather than matching it, so
 * a late `complete` fails here, clearly, rather than at the facilitator as an
 * expired authorization.
 */
const INTENT_TTL_MS = (AUTHORIZATION_TTL_SECONDS - 60) * 1000;

function sweep(): void {
  const now = Date.now();
  for (const [id, intent] of intents) if (intent.expiresAt <= now) intents.delete(id);
}

function remember(input: Omit<Intent, "id" | "expiresAt">): Intent {
  sweep();
  const intent: Intent = { ...input, id: randomUUID(), expiresAt: Date.now() + INTENT_TTL_MS };
  intents.set(intent.id, intent);
  return intent;
}

/**
 * Hand back the intent already in flight for this (person, game, kind).
 *
 * Double-clicking "Pay" must not produce two authorizations: both could settle,
 * and the buyer would own one game and have paid for two.
 */
function liveIntent(userId: string, gameId: string, kind: Intent["kind"]): Intent | undefined {
  const now = Date.now();
  for (const intent of intents.values()) {
    if (intent.userId === userId && intent.gameId === gameId && intent.kind === kind && intent.expiresAt > now) {
      return intent;
    }
  }
  return undefined;
}

/**
 * Taken out of the store before anything is submitted, so a replayed `complete`
 * cannot settle a second payment.
 */
function consume(id: string, userId: string): Intent | undefined {
  const intent = intents.get(id);
  if (!intent) return undefined;
  intents.delete(id);
  if (intent.userId !== userId || intent.expiresAt <= Date.now()) return undefined;
  return intent;
}

/** What the client needs in order to sign. JSON-safe: bigints as strings. */
function preparedShape(intent: Intent) {
  const typed = isGatewayRequirements(intent.requirements)
    ? gatewayTypedDataFor(intent.authorization, intent.requirements.extra.verifyingContract)
    : typedDataFor(intent.authorization);
  return {
    intentId: intent.id,
    expiresAt: new Date(intent.expiresAt).toISOString(),
    amountUnits: intent.requirements.amount,
    asset: intent.requirements.asset,
    payTo: intent.requirements.payTo,
    /**
     * Pass this straight to `eth_signTypedData_v4`. Sent whole rather than as
     * fields for the client to reassemble: the signature only verifies if every
     * byte of the domain and message matches, so rebuilding it on the client is
     * an opportunity to get it subtly wrong.
     */
    typedData: {
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: {
        from: typed.message.from,
        to: typed.message.to,
        value: typed.message.value.toString(),
        validAfter: typed.message.validAfter.toString(),
        validBefore: typed.message.validBefore.toString(),
        nonce: typed.message.nonce,
      },
    },
  };
}

export type PrepareInput = {
  userId: string;
  gameId: string;
  evmAddress: string;
  /** Terms the route already computed, so the quoted price is the signed price. */
  requirements: PaymentRequirements | GatewayPaymentRequirements;
  resource: ResourceInfo;
  bearer?: string;
  kind?: "purchase" | "trial_chunk";
};

export function prepare(input: PrepareInput) {
  const kind = input.kind ?? "purchase";
  const existing = liveIntent(input.userId, input.gameId, kind);
  if (existing) return preparedShape(existing);

  const gateway = isGatewayRequirements(input.requirements);
  const intent = remember({
    userId: input.userId,
    gameId: input.gameId,
    kind,
    settleUrl: kind === "purchase" ? downloadUrl(input.gameId) : trialChunkUrl(input.gameId),
    authorization: gateway
      ? buildGatewayAuthorization(input.evmAddress as Address, input.requirements.payTo, BigInt(input.requirements.amount))
      : buildAuthorization(
          input.evmAddress as Address,
          input.requirements.payTo,
          BigInt(input.requirements.amount),
        ),
    requirements: input.requirements,
    resource: input.resource,
    bearer: input.bearer,
  });
  return preparedShape(intent);
}

/** Settle a signed intent by retrying our own gated route with the payment. */
export async function complete(input: {
  intentId: string;
  userId: string;
  signature: Hex;
}): Promise<unknown> {
  const intent = consume(input.intentId, input.userId);
  if (!intent) {
    throw new AppError(
      409,
      "PAYMENT_INTENT_EXPIRED",
      "That payment timed out or was already used. Start it again — nothing was charged.",
    );
  }

  const headers: Record<string, string> = {
    "payment-signature": encodePaymentHeader({
      requirements: intent.requirements,
      resource: intent.resource,
      authorization: intent.authorization,
      signature: input.signature,
    }),
  };
  if (intent.bearer) headers.authorization = intent.bearer;

  // A loopback with no timeout once wedged the outer request while the money had
  // already moved, with nothing ever failing. Circle's wait window is bounded,
  // so this is past every honest case and far short of forever.
  const res = await fetch(intent.settleUrl, { headers, signal: AbortSignal.timeout(100_000) }).catch((err) => {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new AppError(
        504,
        "PAYMENT_FAILED",
        "Settlement did not come back in time. The payment may still have gone through — check before retrying.",
      );
    }
    throw err;
  });

  const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
  if (!res.ok) {
    throw new AppError(
      res.status,
      body.error?.code ?? "PAYMENT_FAILED",
      body.error?.message ?? "That payment could not be settled.",
      body.error?.details,
    );
  }
  return body;
}

/** Trial chunks use the same two steps against the chunk's own gated route. */
export const prepareTrialChunk = (input: Omit<PrepareInput, "kind">) =>
  prepare({ ...input, kind: "trial_chunk" });
