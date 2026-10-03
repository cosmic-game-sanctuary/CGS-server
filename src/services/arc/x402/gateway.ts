import type { Request } from "express";
import { recoverTypedDataAddress, type Address, type Hex, type TypedDataDomain } from "viem";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS } from "@circle-fin/x402-batching/client";
import { AppError } from "../../../lib/errors.js";
import { env } from "../../../config/env.js";
import { arcChain, USDC_ADDRESS } from "../client.js";
import type { Authorization } from "./authorization.js";
import { payToFor, resourceInfoFor, type DecodedPayment } from "./gate.js";
import type { ResourceInfo } from "./requirements.js";

/**
 * Circle Gateway's x402 batching facilitator — Stage 7's path for trial chunks.
 *
 * A trial chunk is too small for the regular facilitator (Stage 4): gas would
 * exceed the price. Gateway solves this by never settling a single chunk
 * on-chain at all. The buyer deposits once into a `GatewayWallet` contract;
 * every chunk after that is an EIP-3009 authorization against *that* contract
 * (not USDC) that Circle verifies and credits off-chain, batching many buyers'
 * authorizations into one on-chain transaction later. That's why this needs
 * its own domain and its own facilitator client — same message shape as a
 * purchase's `TransferWithAuthorization`, different signing domain, different
 * settlement backend, and (see `arc:check:gateway`'s measured result) a real
 * delay before the money is actually in the vault, even though the chunk is
 * served the instant Gateway's `/settle` answers success. That is Gateway's
 * own documented behaviour, not a bug: "the seller serves the resource
 * immediately, without waiting for onchain settlement."
 * https://developers.circle.com/gateway-nanopayments/concepts/batched-settlement
 *
 * No API key, unlike Stage 4's facilitator — Gateway's x402 endpoints are
 * public, and nothing here binds `payTo` the way settling with a key does.
 */

const GATEWAY_URL = env.ARC_NETWORK === "mainnet" ? "https://gateway-api.circle.com" : "https://gateway-api-testnet.circle.com";

const facilitator = new BatchFacilitatorClient({ url: GATEWAY_URL });

export type GatewayPaymentRequirements = {
  scheme: "exact";
  network: `eip155:${number}`;
  amount: string;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: { name: "GatewayWalletBatched"; version: "1"; verifyingContract: Address };
};

type GatewayKind = { network: string; verifyingContract: Address };

let cached: GatewayKind | undefined;

/**
 * The one piece of Gateway configuration this server needs: the GatewayWallet
 * contract address for Arc, fetched once and kept — it does not vary per
 * request, only per network, and every call after the first is free.
 */
async function getGatewayKind(): Promise<GatewayKind> {
  if (cached) return cached;
  const network = `eip155:${arcChain().id}`;
  const supported = await facilitator.getSupported();
  const kind = supported.kinds.find((k) => k.network === network);
  const verifyingContract = kind?.extra?.verifyingContract as Address | undefined;
  if (!verifyingContract) {
    throw new Error(`Circle Gateway has no GatewayWallet published for ${network}. Checked ${GATEWAY_URL}/v1/x402/supported.`);
  }
  cached = { network, verifyingContract };
  return cached;
}

/** Everything a trial-chunk route needs to quote a price and later settle it. */
export async function gatewayRequirements(payTo: Address, units: bigint): Promise<GatewayPaymentRequirements> {
  if (units <= 0n) throw new Error("Gateway requirements need a positive amount");
  const { network, verifyingContract } = await getGatewayKind();
  return {
    scheme: "exact",
    network: network as `eip155:${number}`,
    amount: units.toString(),
    asset: USDC_ADDRESS,
    payTo,
    // Gateway requires every authorization to outlive its own minimum validity
    // window (currently ~7 days) regardless of what a seller asks for — this is
    // the SDK's own exported constant, not a guess, so it tracks Circle's value
    // if it ever changes.
    maxTimeoutSeconds: GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract },
  };
}

/** The GatewayWallet contract address a buyer deposits into, for the trial panel's deposit step. */
export async function gatewayWalletAddress(): Promise<Address> {
  return (await getGatewayKind()).verifyingContract;
}

// Circle's own Gateway domain id for Arc (both testnet and mainnet) — see
// https://developers.circle.com/gateway/gateway-supported-blockchains. Not
// the EVM chainId; Gateway's balances endpoint wants this instead.
const GATEWAY_ARC_DOMAIN = 26;

/**
 * A buyer's spendable Gateway balance on Arc, in atomic USDC units. Plain
 * fetch against Circle's documented, unauthenticated balances endpoint
 * (https://developers.circle.com/api-reference/gateway/all/get-token-balances)
 * rather than the full `GatewayClient` — that class needs a private key to
 * construct, which this server has no business holding for a buyer's wallet.
 */
export async function gatewayAvailableUnits(address: Address): Promise<bigint> {
  const res = await fetch(`${GATEWAY_URL}/v1/balances`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: [{ depositor: address, domain: GATEWAY_ARC_DOMAIN }] }),
  });
  if (!res.ok) throw new Error(`Gateway balances lookup failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { balances?: { balance: string }[] };
  const balance = data.balances?.[0]?.balance;
  if (!balance) return 0n;
  // Comes back as a decimal USDC string ("0.05"), not atomic units.
  return BigInt(Math.round(Number(balance) * 1_000_000));
}

type Game = { id: string; vaultAddress: string | null; title: string };

export type GatewayGateTerms = { requirements: GatewayPaymentRequirements; resource: ResourceInfo; payTo: Address };

/** The Gateway-shaped equivalent of gate.ts#termsFor, for the trial-chunk routes only. */
export async function gatewayTermsFor(req: Request, game: Game, owedUnits: number, description: string): Promise<GatewayGateTerms> {
  const payTo = payToFor(game);
  return {
    requirements: await gatewayRequirements(payTo, BigInt(owedUnits)),
    resource: resourceInfoFor(req, description),
    payTo,
  };
}

export const gatewayChallengeBody = (terms: GatewayGateTerms) => ({
  x402Version: 2,
  resource: terms.resource,
  accepts: [terms.requirements],
});

function gatewayRequirementsMatch(offered: GatewayPaymentRequirements, claimed: unknown): boolean {
  if (typeof claimed !== "object" || claimed === null) return false;
  const c = claimed as Partial<GatewayPaymentRequirements>;
  return (
    c.scheme === offered.scheme &&
    c.network === offered.network &&
    c.amount === offered.amount &&
    typeof c.asset === "string" &&
    c.asset.toLowerCase() === offered.asset.toLowerCase() &&
    typeof c.payTo === "string" &&
    c.payTo.toLowerCase() === offered.payTo.toLowerCase()
  );
}

export function gatewayDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
  return { name: "GatewayWalletBatched", version: "1", chainId, verifyingContract };
}

/** What a client signs over for a Gateway chunk — same message shape as the USDC one, different domain. */
export function gatewayTypedDataFor(auth: Authorization, verifyingContract: Address) {
  return {
    domain: gatewayDomain(arcChain().id, verifyingContract),
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    } as const,
    primaryType: "TransferWithAuthorization" as const,
    message: auth,
  };
}

export const recoverGatewayPayer = (auth: Authorization, signature: Hex, verifyingContract: Address): Promise<Address> =>
  recoverTypedDataAddress({ ...gatewayTypedDataFor(auth, verifyingContract), signature });

/**
 * A Gateway authorization is valid for ~7 days, not the 30 minutes a purchase
 * gets — Gateway rejects anything shorter (measured: `arc:check:gateway`
 * signs exactly this window and Circle accepts it). `validAfter` is backdated
 * ten minutes, matching the SDK's own client, as slack against clock drift.
 */
export function buildGatewayAuthorization(from: Address, to: Address, units: bigint): Authorization {
  const now = Math.floor(Date.now() / 1000);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  return {
    from,
    to,
    value: units,
    validAfter: BigInt(now - 600),
    validBefore: BigInt(now + GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS),
    nonce: `0x${Buffer.from(nonceBytes).toString("hex")}` as Hex,
  };
}

type LocalCheck = { ok: true } | { ok: false; reason: string; message: string };

/**
 * The checks worth doing before spending a Gateway round trip on it. No
 * balance check here — unlike the USDC-domain path, the relevant balance is
 * the buyer's *Gateway* balance, which only Circle's own `/verify` can read,
 * so that check is simply left to Circle, same as the nonce-already-used
 * check (no local view of GatewayWallet's internal ledger exists to ask).
 */
async function checkGatewayAuthorizationLocally(
  auth: Authorization,
  signature: Hex,
  expected: { to: Address; units: bigint },
  verifyingContract: Address,
): Promise<LocalCheck> {
  if (auth.to.toLowerCase() !== expected.to.toLowerCase()) {
    return { ok: false, reason: "invalid_exact_evm_payload_recipient_mismatch", message: `This payment pays ${auth.to}, but this game's money goes to ${expected.to}.` };
  }
  if (auth.value !== expected.units) {
    return { ok: false, reason: "invalid_exact_evm_payload_authorization_value_mismatch", message: `This payment authorizes ${auth.value} units; the price is ${expected.units}.` };
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (auth.validAfter > now) {
    return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_after", message: "This payment is not valid yet." };
  }
  if (auth.validBefore <= now) {
    return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_before", message: "This payment authorization has expired. Sign a new one." };
  }
  let payer: Address;
  try {
    payer = await recoverGatewayPayer(auth, signature, verifyingContract);
  } catch {
    return { ok: false, reason: "invalid_exact_evm_payload_signature", message: "That signature could not be read." };
  }
  if (payer.toLowerCase() !== auth.from.toLowerCase()) {
    return { ok: false, reason: "invalid_exact_evm_payload_signature", message: "That signature was not made by the wallet it claims to come from." };
  }
  return { ok: true };
}

export type SettledGatewayPayment = { transferId: string; payer: Address; amountUnits: number };

/**
 * The trial-chunk route's equivalent of gate.ts#settleFromHeader. Kept
 * separate rather than folded into that function: `/download` must never
 * change behaviour because of anything in this file, and this settles against
 * a different facilitator entirely.
 */
export async function settleGatewayFromHeader(terms: GatewayGateTerms, payment: DecodedPayment, resource: ResourceInfo): Promise<SettledGatewayPayment> {
  if (!gatewayRequirementsMatch(terms.requirements, payment.accepted)) {
    throw new AppError(402, "PAYMENT_REQUIRED", "The payment doesn't match this game's price.");
  }

  const local = await checkGatewayAuthorizationLocally(
    payment.authorization,
    payment.signature,
    { to: terms.payTo, units: BigInt(terms.requirements.amount) },
    terms.requirements.extra.verifyingContract,
  );
  if (!local.ok) {
    throw new AppError(402, "PAYMENT_REQUIRED", local.message, { reason: local.reason });
  }

  const outcome = await settleGatewayPayment(terms.requirements, payment.authorization, payment.signature, resource);
  if (outcome.status === "failed") {
    throw new AppError(402, "PAYMENT_REQUIRED", outcome.message, { reason: outcome.reason });
  }
  // `payment.authorization.from`, not `outcome.payer`: Circle's Gateway
  // settle response echoes the payer lowercased, which silently broke trial
  // credit lookups (buyerAccountId stored lowercase, `trialChunksFor` filters
  // on exact-case equality against a checksummed session address — measured,
  // not assumed: `arc:check:purchase` caught it directly). `checkGatewayAuthorizationLocally`
  // has already cryptographically confirmed this is who signed, in the exact
  // case the request carried, so there is nothing to gain from Circle's own
  // copy of the same fact.
  return { transferId: outcome.transferId, payer: payment.authorization.from, amountUnits: Number(terms.requirements.amount) };
}

export type GatewaySettlementOutcome =
  | { status: "settled"; transferId: string; payer: Address }
  | { status: "failed"; reason: string; message: string };

/**
 * Verify then settle a signed Gateway chunk. Unlike Stage 4's facilitator
 * there is no "pending" state to poll here — Gateway's own documented model is
 * verify-and-credit-immediately, with the on-chain batch landing later and out
 * of band. A seller is meant to serve the resource the moment this returns
 * `settled`, not wait for a transaction hash that does not exist yet.
 */
export async function settleGatewayPayment(
  requirements: GatewayPaymentRequirements,
  authorization: Authorization,
  signature: Hex,
  resource: ResourceInfo,
): Promise<GatewaySettlementOutcome> {
  const payload = {
    authorization: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
      nonce: authorization.nonce,
    },
    signature,
  };
  const paymentPayload = { x402Version: 2, payload, accepted: requirements, resource };

  const verified = await facilitator.verify(paymentPayload as never, requirements as never);
  if (!verified.isValid) {
    return { status: "failed", reason: verified.invalidReason ?? "invalid", message: gatewayMessage(verified.invalidReason) };
  }

  const settled = await facilitator.settle(paymentPayload as never, requirements as never);
  if (!settled.success || !settled.transaction) {
    return { status: "failed", reason: settled.errorReason ?? "unknown", message: gatewayMessage(settled.errorReason) };
  }
  return { status: "settled", transferId: settled.transaction, payer: (settled.payer ?? authorization.from) as Address };
}

function gatewayMessage(reason?: string): string {
  switch (reason) {
    case "insufficient_funds":
      return "That wallet hasn't deposited enough into Gateway for this.";
    case "invalid_exact_evm_payload_signature":
      return "The payment signature wasn't valid.";
    case "invalid_exact_evm_payload_recipient_mismatch":
      return "The payment was addressed to the wrong recipient.";
    case "invalid_exact_evm_payload_authorization_value_mismatch":
      return "The payment amount didn't match the price.";
    case "invalid_transaction_state":
      return "This payment has already been settled.";
    default:
      return `This payment could not be settled${reason ? ` (${reason})` : ""}.`;
  }
}
