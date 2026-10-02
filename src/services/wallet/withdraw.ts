import { randomUUID } from "node:crypto";
import { createWalletClient, http, isAddress, type Address, type Hex } from "viem";
import { arcChain, confirm, feeOverrides, publicClient, unitsToWei, USDC_ADDRESS, weiToUnits } from "../arc/client.js";
import { getUsdcUnits } from "../arc/reads.js";
import { privyViemAccount } from "../arc/x402/payer.js";
import { AppError, Errors } from "../../lib/errors.js";
import logger from "../../utils/logger.utils.js";

/**
 * Taking money back out of the wallet Privy made for you.
 *
 * **Almost all of this used to be server-side and no longer needs to be.** On
 * Hedera a withdrawal had to be built, frozen and submitted here so that the
 * *operator* could pay the network fee — a wallet holding only USDC and no HBAR
 * was otherwise a wallet you could not empty. On Arc the fee is denominated in
 * USDC, which is the same asset being withdrawn, so a wallet with money in it
 * can always afford to move that money. The entire reason for the server to
 * stand in the middle is gone.
 *
 * So this is now validation and a receipt, not orchestration:
 *
 *   `prepare` checks the destination and the amount against the live balance and
 *   hands back the exact transaction to send. The browser sends it with the
 *   buyer's own wallet, because the key belongs to them — the same division of
 *   authority as a purchase.
 *
 *   `confirm` verifies on chain that the transaction it is told about really did
 *   move the amount to the destination. It is a receipt, so it cannot be
 *   fooled by a client reporting a withdrawal that did not happen.
 *
 * This replaces the earnings withdrawal too, but only for a wallet balance. A
 * developer's *share of sales* is never withdrawn from us at all: it accrues in
 * the game's SplitVault and they call `claim()` on it themselves.
 */

export type WithdrawIntent = {
  id: string;
  userId: string;
  from: Address;
  to: Address;
  amountUnits: bigint;
  expiresAt: number;
};

const TTL_MS = 10 * 60 * 1000;
const intents = new Map<string, WithdrawIntent>();

function sweep(): void {
  const now = Date.now();
  for (const [id, intent] of intents) if (intent.expiresAt <= now) intents.delete(id);
}

/**
 * Gas has to come out of the same balance being moved, so sending *everything*
 * would leave nothing to pay for sending it. This is held back from a
 * "withdraw all" and is deliberately generous — a plain transfer costs about a
 * tenth of this.
 */
export const GAS_RESERVE_UNITS = 20_000n;

export async function prepareWithdraw(input: {
  userId: string;
  from: Address;
  to: string;
  /** Omit to send everything the wallet can afford to send. */
  amountUnits?: bigint;
}): Promise<WithdrawIntent & { reservedForGasUnits: bigint }> {
  sweep();

  if (!isAddress(input.to)) {
    throw Errors.validationFailed({ to: "That doesn't look like a wallet address." });
  }
  const to = input.to as Address;
  if (to.toLowerCase() === input.from.toLowerCase()) {
    throw Errors.validationFailed({ to: "That is this wallet. Send it somewhere else." });
  }

  const balanceUnits = await getUsdcUnits(input.from);
  const sendable = balanceUnits > GAS_RESERVE_UNITS ? balanceUnits - GAS_RESERVE_UNITS : 0n;

  const amountUnits = input.amountUnits ?? sendable;
  if (amountUnits <= 0n) {
    throw Errors.validationFailed({
      amountUnits:
        balanceUnits === 0n
          ? "There is nothing in this wallet to withdraw yet."
          : "There is not enough here to cover the transfer fee as well.",
    });
  }
  if (amountUnits > balanceUnits) {
    throw Errors.validationFailed({ amountUnits: `That is more than this wallet holds (${balanceUnits}).` });
  }
  if (amountUnits > sendable) {
    throw Errors.validationFailed({
      amountUnits: `Leave at least ${GAS_RESERVE_UNITS} units for the transfer fee — the most you can send is ${sendable}.`,
    });
  }

  const intent: WithdrawIntent = {
    id: randomUUID(),
    userId: input.userId,
    from: input.from,
    to,
    amountUnits,
    expiresAt: Date.now() + TTL_MS,
  };
  intents.set(intent.id, intent);
  return { ...intent, reservedForGasUnits: GAS_RESERVE_UNITS };
}

/** The transaction the browser should send. Native USDC, so no token call. */
export function transactionFor(intent: WithdrawIntent) {
  return {
    to: intent.to,
    /** Native 18-decimal wei, which is what a wallet expects in `value`. */
    value: unitsToWei(intent.amountUnits).toString(),
    chainId: arcChain().id,
  };
}

export function consumeWithdrawIntent(id: string, userId: string): WithdrawIntent | undefined {
  const intent = intents.get(id);
  if (!intent) return undefined;
  intents.delete(id);
  if (intent.userId !== userId || intent.expiresAt <= Date.now()) return undefined;
  return intent;
}

/**
 * Confirm a withdrawal actually happened, from the chain rather than from the
 * client's word for it.
 */
export async function confirmWithdraw(
  intent: WithdrawIntent,
  txHash: Hex,
): Promise<{ txHash: Hex; amountUnits: bigint; to: Address }> {
  const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  if (receipt.status !== "success") {
    throw new AppError(422, "WITHDRAW_FAILED", "That transaction failed on chain. Nothing was sent.");
  }

  const tx = await publicClient().getTransaction({ hash: txHash });
  const sameParties =
    tx.from.toLowerCase() === intent.from.toLowerCase() && tx.to?.toLowerCase() === intent.to.toLowerCase();
  if (!sameParties || weiToUnits(tx.value) !== intent.amountUnits) {
    throw new AppError(
      422,
      "WITHDRAW_MISMATCH",
      "That transaction does not match the withdrawal it was sent for.",
    );
  }
  return { txHash, amountUnits: weiToUnits(tx.value), to: intent.to };
}

/**
 * Hand an agent's leftover balance back to the person who funded it.
 *
 * The one withdrawal the server may do on someone's behalf, and only because the
 * wallet in question is one *we* created for the agent — never a person's own.
 * It runs with no browser round trip, which is what lets an agent be retired or
 * expired by a background sweep rather than only while its owner is watching.
 *
 * Returns null when there is nothing worth sending: the balance has to cover the
 * fee to move it, and an agent whose remaining balance is smaller than its own
 * transfer fee has, in every sense that matters, nothing left.
 */
export async function refundAgentBalance(input: {
  agentWalletId: string;
  agentAddress: Address;
  to: Address;
  amountUnits: bigint;
}): Promise<Hex | null> {
  const sendable = input.amountUnits > GAS_RESERVE_UNITS ? input.amountUnits - GAS_RESERVE_UNITS : 0n;
  if (sendable <= 0n) {
    logger.info(
      { agentAddress: input.agentAddress, amountUnits: input.amountUnits.toString() },
      "agent balance is too small to cover its own refund fee — nothing sent",
    );
    return null;
  }

  const account = privyViemAccount(input.agentWalletId, input.agentAddress);
  const wallet = createWalletClient({ account, chain: arcChain(), transport: http() });
  const hash = await wallet.sendTransaction({
    account,
    chain: arcChain(),
    to: input.to,
    value: unitsToWei(sendable),
    ...(await feeOverrides()),
  });
  await confirm(hash);
  return hash;
}

export { USDC_ADDRESS };
