import type { Address } from "viem";
import { arcChain, USDC_ADDRESS } from "../client.js";

/**
 * x402 v2 payment terms, in the exact shape Circle's facilitator validates
 * against. See https://developers.circle.com/api-reference/facilitator-service/settle-payment
 *
 * `payTo` is the one field carrying the whole product argument. It is the game's
 * own `SplitVault`, so the money a buyer authorizes never passes through an
 * account we control — a settled payment lands in a contract whose split was
 * fixed when the game was published and which has no function that could
 * redirect it. Our cut comes out of that contract like everyone else's.
 */

export type PaymentRequirements = {
  scheme: "exact";
  network: `eip155:${number}`;
  /** Atomic USDC units, as a decimal string. 6 decimals. */
  amount: string;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: { name: "USDC"; version: "2"; assetTransferMethod: "eip3009" };
};

export type ResourceInfo = {
  url: string;
  description: string;
  mimeType: string;
};

/**
 * Arc has instant finality, so a settlement either resolves inside the HTTP
 * wait window or something is wrong. Circle's own examples use 12s; we allow a
 * little more because a buyer on a slow connection is not a failed payment, and
 * `settlement_pending` is handled either way.
 */
const MAX_TIMEOUT_SECONDS = 30;

export function buildRequirements(payTo: Address, units: bigint): PaymentRequirements {
  if (units <= 0n) throw new Error("x402 requirements need a positive amount");
  return {
    scheme: "exact",
    network: `eip155:${arcChain().id}`,
    amount: units.toString(),
    asset: USDC_ADDRESS,
    payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
  };
}

/** The body of a `402` response: what the resource is, and how to pay for it. */
export function paymentRequiredBody(requirements: PaymentRequirements, resource: ResourceInfo) {
  return { x402Version: 2, resource, accepts: [requirements] };
}

/**
 * Does a payload's claimed terms match what we are actually offering?
 *
 * Checked before settling, because the payload is attacker-controlled: a client
 * that could hand back altered terms could name its own `payTo` and have the
 * facilitator validate the authorization against *that* rather than against the
 * game's vault.
 */
export function requirementsMatch(offered: PaymentRequirements, claimed: unknown): boolean {
  if (typeof claimed !== "object" || claimed === null) return false;
  const c = claimed as Partial<PaymentRequirements>;
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
