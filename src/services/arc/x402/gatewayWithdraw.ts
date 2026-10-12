import { randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import { AppError, Errors } from "../../../lib/errors.js";
import {
  buildGatewayBurnIntent,
  gatewayAvailableUnits,
  gatewayBurnIntentTypedData,
  gatewayMintTransaction,
  recoverGatewayBurnSigner,
  submitGatewayBurnIntent,
  type BurnIntent,
} from "./gateway.js";

/**
 * Pulling an unused Gateway deposit back out to your own wallet.
 *
 * Shaped like services/wallet/withdraw.ts's regular withdrawal: `prepare`
 * builds the exact thing to sign and holds it server-side so `complete`
 * can't be handed a different intent than the one actually quoted, and the
 * browser signs with the buyer's own Privy wallet — never this server, same
 * rule as every other authorization in this app. The one extra step a
 * regular withdrawal doesn't have: Circle has to attest the burn before
 * anyone can mint it back out, so `complete` calls Circle itself and hands
 * the browser an attestation to submit on-chain, rather than a raw
 * transaction ready to sign immediately.
 */

export type GatewayWithdrawIntent = {
  id: string;
  userId: string;
  address: Address;
  burnIntent: BurnIntent;
  expiresAt: number;
};

const TTL_MS = 10 * 60 * 1000;
const intents = new Map<string, GatewayWithdrawIntent>();

function sweep(): void {
  const now = Date.now();
  for (const [id, intent] of intents) if (intent.expiresAt <= now) intents.delete(id);
}

/**
 * The ceiling the signer authorizes Circle to deduct — not a cost measured
 * here. A same-chain withdrawal is Circle's documented "instant" path, and
 * the reference SDK's own default ceiling is 2.01 USDC, clearly sized for
 * far larger transfers than anything this app moves through Gateway. $0.01
 * is a hundred times a typical trial chunk and still leaves headroom; if
 * it's ever not enough, Circle's own error names the reason rather than
 * failing silently.
 */
const MAX_FEE_UNITS = 10_000n;

export async function prepareGatewayWithdraw(
  userId: string,
  address: Address,
  amountUnits?: bigint,
): Promise<{ withdrawId: string; typedData: ReturnType<typeof gatewayBurnIntentTypedData>; amountUnits: bigint; expiresAt: number }> {
  sweep();

  const available = await gatewayAvailableUnits(address);
  const units = amountUnits ?? available;
  if (units <= 0n) {
    throw Errors.validationFailed({ amountUnits: "There's nothing in Gateway to withdraw." });
  }
  if (units > available) {
    throw Errors.validationFailed({ amountUnits: `Only ${available} units are available in Gateway right now.` });
  }

  const burnIntent = await buildGatewayBurnIntent(address, address, units, MAX_FEE_UNITS);
  const id = randomUUID();
  const expiresAt = Date.now() + TTL_MS;
  intents.set(id, { id, userId, address, burnIntent, expiresAt });

  return { withdrawId: id, typedData: gatewayBurnIntentTypedData(burnIntent), amountUnits: units, expiresAt };
}

export async function completeGatewayWithdraw(
  userId: string,
  withdrawId: string,
  signature: Hex,
): Promise<{ amountUnits: bigint; mintTransaction: ReturnType<typeof gatewayMintTransaction> }> {
  const intent = intents.get(withdrawId);
  const expired = () => Errors.validationFailed({ withdrawId: "That withdrawal expired or was already used. Start it again." });
  if (!intent) throw expired();
  intents.delete(withdrawId);
  if (intent.userId !== userId || intent.expiresAt <= Date.now()) throw expired();

  const signer = await recoverGatewayBurnSigner(intent.burnIntent, signature);
  if (signer.toLowerCase() !== intent.address.toLowerCase()) {
    throw new AppError(403, "GATEWAY_WITHDRAW_SIGNATURE_MISMATCH", "That signature wasn't made by this wallet.");
  }

  const outcome = await submitGatewayBurnIntent(intent.burnIntent, signature);
  if (outcome.status === "failed") {
    throw new AppError(502, "GATEWAY_WITHDRAW_FAILED", outcome.message);
  }

  return { amountUnits: intent.burnIntent.spec.value, mintTransaction: gatewayMintTransaction(outcome.attestation, outcome.signature) };
}
