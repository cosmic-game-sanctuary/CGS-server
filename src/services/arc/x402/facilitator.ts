import { keccak256, toBytes, type Address, type Hex } from "viem";
import { env } from "../../../config/env.js";
import { arcChain, operator } from "../client.js";
import type { Authorization } from "./authorization.js";
import type { PaymentRequirements, ResourceInfo } from "./requirements.js";
import logger from "../../../utils/logger.utils.js";

/**
 * Circle's Facilitator Service — the thing that makes a purchase cost the buyer
 * nothing at all.
 *
 * It verifies the buyer's EIP-3009 authorization, screens both parties, submits
 * the USDC transfer, and **pays the gas itself**. That single fact is why this
 * port is affordable: the payment leg of every sale, forever, costs us nothing
 * and costs the buyer nothing. We never hold the money and never run a relayer.
 *
 * Plain `fetch`, no SDK — same reasoning as HCS-14 and Groq elsewhere in this
 * repo. The surface is two POSTs and a GET, and an SDK would be a dependency
 * between us and a documented HTTP contract.
 *
 * Docs: https://developers.circle.com/facilitator-service
 */

const SETTLE_PATH = "/v1/facilitator/x402/settle";
const STATUS_PATH = "/v1/facilitator/x402/status";

export type SettlementOutcome =
  | { status: "settled"; transaction: Hex; payer: Address; amount: string }
  | { status: "pending"; paymentId: string; statusUrl: string; payer?: string }
  | { status: "failed"; reason: string; message: string; paymentId?: string };

type SettleResponse = {
  success: boolean;
  payer?: string;
  transaction?: string;
  network?: string;
  amount?: string;
  errorReason?: string;
  extensions?: {
    "settlement-status"?: { status: string; paymentId: string; statusUrl: string };
  };
};

export class FacilitatorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FacilitatorConfigError";
  }
}

/**
 * Two ways to authenticate, and the choice is forced by what `payTo` is.
 *
 * An **API key** is the production path. It authenticates the request outright
 * and places no requirement on `payTo`, which is what lets `payTo` be a vault
 * contract.
 *
 * The **keyless trial** instead wants a `Facilitator-Seller-Proof`: an EIP-712
 * signature *from the key controlling `payTo`*. A `SplitVault` has no key, and
 * the documented alternative — implementing ERC-1271 on it — would mean giving
 * the vault a designated signer purely to prove identity to Circle. That is a
 * privileged role on a contract whose entire value is having none, so we do not
 * do it. The seller proof is therefore only usable when `payTo` is the operator
 * itself, which is a development convenience and never how a real sale settles.
 */
function hasApiKey(): boolean {
  return Boolean(env.CIRCLE_API_KEY);
}

async function sellerProof(purpose: "settle" | "status", method: string, body: string, payTo: Address): Promise<string> {
  const account = operator();
  if (payTo.toLowerCase() !== account.address.toLowerCase()) {
    throw new FacilitatorConfigError(
      `CIRCLE_API_KEY is not set, so settlement falls back to Circle's keyless trial — which needs a ` +
        `seller proof signed by the key controlling payTo. payTo here is ${payTo}, which this server ` +
        `holds no key for (it is the game's SplitVault). Set CIRCLE_API_KEY; it is free from ` +
        `https://console.circle.com and is the only supported way to settle to a contract.`,
    );
  }

  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = `0x${Buffer.from(nonceBytes).toString("hex")}` as Hex;
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 300;
  const network = `eip155:${arcChain().id}`;

  const signature = await account.signTypedData({
    domain: { name: "Circle Facilitator Seller Request", version: "1", chainId: arcChain().id },
    types: {
      SellerRequest: [
        { name: "purpose", type: "string" },
        { name: "method", type: "string" },
        { name: "bodyHash", type: "bytes32" },
        { name: "network", type: "string" },
        { name: "payTo", type: "address" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint64" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    primaryType: "SellerRequest",
    message: {
      purpose,
      method: method.toUpperCase(),
      bodyHash: keccak256(toBytes(body)),
      network,
      payTo,
      nonce,
      issuedAt: BigInt(issuedAt),
      expiresAt: BigInt(expiresAt),
    },
  });

  const envelope = { version: 1, signature, network, payTo, nonce, issuedAt, expiresAt };
  return Buffer.from(JSON.stringify(envelope)).toString("base64url");
}

async function authHeaders(purpose: "settle" | "status", method: string, body: string, payTo: Address) {
  if (hasApiKey()) return { authorization: `Bearer ${env.CIRCLE_API_KEY}` };
  return { "facilitator-seller-proof": await sellerProof(purpose, method, body, payTo) };
}

export type SettleInput = {
  requirements: PaymentRequirements;
  resource: ResourceInfo;
  authorization: Authorization;
  signature: Hex;
  /**
   * Idempotency, scoped to our seller account. Retrying with the same id
   * converges on the same payment rather than charging twice — which is the
   * difference between a safe retry and a double charge, since a timeout is
   * explicitly *not* evidence of failure.
   */
  paymentId: string;
};

function settleBody(input: SettleInput) {
  const { requirements, resource, authorization: a } = input;
  const payload = {
    signature: input.signature,
    authorization: {
      from: a.from,
      to: a.to,
      value: a.value.toString(),
      validAfter: a.validAfter.toString(),
      validBefore: a.validBefore.toString(),
      nonce: a.nonce,
    },
  };
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: requirements,
      payload,
      resource,
      extensions: { "payment-identifier": { info: { required: true, id: input.paymentId } } },
    },
    paymentRequirements: requirements,
  };
}

const REQUEST_TIMEOUT_MS = 45_000;

export async function settlePayment(input: SettleInput): Promise<SettlementOutcome> {
  const body = JSON.stringify(settleBody(input));
  const url = `${env.CIRCLE_FACILITATOR_URL}${SETTLE_PATH}`;
  const headers = {
    "content-type": "application/json",
    ...(await authHeaders("settle", "POST", body, input.requirements.payTo)),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    // The request itself never completed, so we do not know whether Circle
    // recorded the payment. Never treat this as failed-and-safe-to-recharge:
    // the same paymentId must be replayed to find out.
    throw new Error(
      `Could not reach Circle's facilitator (${err instanceof Error ? err.message : String(err)}). ` +
        `Retry with paymentId ${input.paymentId} — do not re-sign.`,
    );
  }

  const text = await res.text();
  let parsed: SettleResponse & { code?: number; message?: string; errors?: { reason?: string }[] };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`Circle's facilitator returned ${res.status} with a non-JSON body: ${text.slice(0, 300)}`);
  }

  // A rejected request (4xx/5xx) carries no settlement outcome at all.
  if (!res.ok) {
    const reason = parsed.errors?.[0]?.reason ?? `http_${res.status}`;
    logger.error({ status: res.status, reason, paymentId: input.paymentId }, "Circle facilitator rejected the settle request");
    return { status: "failed", reason, message: circleMessage(res.status, reason, parsed.message) };
  }

  if (parsed.success && parsed.transaction) {
    return {
      status: "settled",
      transaction: parsed.transaction as Hex,
      payer: (parsed.payer ?? input.authorization.from) as Address,
      amount: parsed.amount ?? input.requirements.amount,
    };
  }

  const ext = parsed.extensions?.["settlement-status"];
  if (parsed.errorReason === "settlement_pending" && ext) {
    return { status: "pending", paymentId: ext.paymentId, statusUrl: ext.statusUrl, payer: parsed.payer };
  }

  return {
    status: "failed",
    reason: parsed.errorReason ?? "unknown",
    message: reasonMessage(parsed.errorReason),
    paymentId: ext?.paymentId,
  };
}

export type StatusOutcome =
  | { status: "completed"; transaction: Hex; payer: Address; amount: string }
  | { status: "pending" }
  | { status: "failed"; reason: string };

/**
 * Reconcile a payment whose outcome was unresolved when `/settle` returned.
 *
 * Needed because "pending" is not failure and must never be fulfilled on: the
 * transfer may well land a moment later. `statusUrl` comes from the settle
 * response rather than being rebuilt, so this follows Circle's own pointer.
 */
export async function getPaymentStatus(statusUrl: string, payTo: Address): Promise<StatusOutcome> {
  const path = new URL(statusUrl).pathname;
  const url = `${env.CIRCLE_FACILITATOR_URL}${path}`;
  const headers = await authHeaders("status", "GET", "", payTo);

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const body = (await res.json()) as { status?: string; transaction?: string; payer?: string; amount?: string; reason?: string };
  if (!res.ok) return { status: "failed", reason: `http_${res.status}` };

  if (body.status === "completed" && body.transaction) {
    return { status: "completed", transaction: body.transaction as Hex, payer: body.payer as Address, amount: body.amount ?? "" };
  }
  if (body.status === "failed") return { status: "failed", reason: body.reason ?? "unknown" };
  return { status: "pending" };
}

/** How long to keep reconciling a pending payment before giving up on this request. */
const PENDING_POLL_MS = 20_000;

export async function awaitSettlement(outcome: SettlementOutcome, payTo: Address): Promise<SettlementOutcome> {
  if (outcome.status !== "pending") return outcome;

  const deadline = Date.now() + PENDING_POLL_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const status = await getPaymentStatus(outcome.statusUrl, payTo);
    if (status.status === "completed") {
      return { status: "settled", transaction: status.transaction, payer: status.payer, amount: status.amount };
    }
    if (status.status === "failed") {
      return { status: "failed", reason: status.reason, message: reasonMessage(status.reason), paymentId: outcome.paymentId };
    }
  }
  return outcome;
}

function circleMessage(httpStatus: number, reason: string, raw?: string): string {
  if (reason === "registration_required") {
    return (
      "Circle's keyless trial allowance for this payout address is used up. Set CIRCLE_API_KEY " +
      "(free, from https://console.circle.com) to keep settling."
    );
  }
  if (httpStatus === 401) return "Circle rejected our credentials for this settlement.";
  if (httpStatus === 429) return "Circle is rate-limiting settlements right now. Try again shortly.";
  return raw ?? `Circle refused this settlement (${reason}).`;
}

/** Circle's `errorReason` codes, in words a buyer could act on. */
function reasonMessage(reason?: string): string {
  switch (reason) {
    case "insufficient_funds":
      return "That wallet doesn't hold enough USDC for this.";
    case "invalid_exact_evm_payload_signature":
      return "The payment signature wasn't valid.";
    case "invalid_exact_evm_payload_recipient_mismatch":
      return "The payment was addressed to the wrong recipient.";
    case "invalid_exact_evm_payload_authorization_value_mismatch":
      return "The payment amount didn't match the price.";
    case "invalid_exact_evm_payload_authorization_valid_before":
      return "The payment authorization expired before it could settle. Try again.";
    case "invalid_transaction_state":
      return "This payment was already used.";
    case "settlement_pending":
      return "Settlement is still in progress.";
    default:
      return `This payment could not be settled${reason ? ` (${reason})` : ""}.`;
  }
}
