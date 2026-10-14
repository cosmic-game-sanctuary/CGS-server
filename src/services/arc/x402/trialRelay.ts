import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { db } from "../../../db/client.js";
import { games, sales } from "../../../db/schema.js";
import logger from "../../../utils/logger.utils.js";
import { arcChain, confirm, feeOverrides, operator, publicClient, USDC_ADDRESS, walletClient } from "../client.js";
import {
  buildGatewayBurnIntent,
  gatewayAvailableUnits,
  gatewayBurnIntentTypedData,
  gatewayTransfer,
  gatewayWalletAddress,
  submitGatewayBurnIntent,
  submitGatewayMint,
} from "./gateway.js";
import { MAX_FEE_UNITS } from "./gatewayWithdraw.js";

/**
 * Getting trial revenue from Gateway into the game's vault, automatically.
 *
 * A trial chunk is paid to the operator (see `gatewayTermsFor`) because Gateway
 * credits a payee's balance *inside Gateway* and a vault has no key to withdraw
 * it. Once Circle's batch for a chunk has `completed`, the money is in the
 * operator's Gateway balance, and this forwards each game's completed chunks to
 * its vault as one same-chain withdrawal whose recipient is the vault. The vault
 * receives real USDC exactly as it does from a purchase, so splits, claims and
 * `/money` need no special case.
 *
 * What this costs in trust, stated once: for the minutes between a chunk and
 * its relay, trial money is held by the operator. Every relay is a public
 * transaction naming the vault as recipient, and purchases never touch this.
 *
 * Idempotency: rows flip to `distributed` only after the mint is mined. A crash
 * between the two would relay the same chunks again, paid from the operator's
 * float, so the worst case is bounded by one batch and is logged with its hash.
 */

/** Relay a game's chunks once they add up to this much, to amortise Circle's fee. */
export const RELAY_MIN_UNITS = 100_000n; // $0.10
/** Or once the oldest has waited this long, so a quiet game still gets paid. */
export const RELAY_MAX_AGE_MS = 6 * 60 * 60_000;
/** Kept in Gateway beyond what is being relayed, because Circle's fee comes out on top. */
const FLOAT_TARGET_UNITS = 1_000_000n; // $1
/** Never top the float up from a wallet that would be left with less than this. */
const OPERATOR_RESERVE_UNITS = 1_000_000n;
const POLL_CAP = 100;

const depositAbi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "value", type: "uint256" }], outputs: [] },
] as const;

let running = false;

export type RelayResult = {
  relayed: { gameId: string; units: string; txHash: Hex }[];
  waiting: number;
  stranded: number;
};

/**
 * One pass. Safe to call on a timer: it never throws, skips if a pass is still
 * running, and leaves anything it cannot finish for the next one.
 */
export async function relayTrialRevenue(opts: { minUnits?: bigint; maxAgeMs?: number } = {}): Promise<RelayResult> {
  const result: RelayResult = { relayed: [], waiting: 0, stranded: 0 };
  if (running) return result;
  running = true;
  try {
    const minUnits = opts.minUnits ?? RELAY_MIN_UNITS;
    const maxAgeMs = opts.maxAgeMs ?? RELAY_MAX_AGE_MS;
    const me = operator().address.toLowerCase();

    const rows = await db
      .select()
      .from(sales)
      .where(and(eq(sales.kind, "trial_chunk"), eq(sales.splitStatus, "pending"), isNotNull(sales.gatewayTransferId)))
      .orderBy(asc(sales.createdAt))
      .limit(POLL_CAP);
    if (rows.length === 0) return result;

    // Which of these have actually landed in the operator's Gateway balance.
    const ready: typeof rows = [];
    // A few at a time: this runs on a timer against Circle's public API.
    const POLL_CONCURRENCY = 8;
    for (let i = 0; i < rows.length; i += POLL_CONCURRENCY) {
      await Promise.all(
        rows.slice(i, i + POLL_CONCURRENCY).map(async (row) => {
        const t = await gatewayTransfer(row.gatewayTransferId!).catch(() => null);
        if (!t) return void (result.waiting += 1);
        if (t.toAddress.toLowerCase() !== me) {
          // Paid to the game's vault under the old design: that money is credited
          // to the vault's own Gateway balance, which nothing can withdraw.
          await db
            .update(sales)
            .set({ splitStatus: "failed", splitError: "paid to the vault's Gateway balance (earlier design); not recoverable" })
            .where(eq(sales.id, row.id));
          result.stranded += 1;
          return;
        }
        if (t.status === "completed") ready.push(row);
        else if (t.status === "failed") {
          await db.update(sales).set({ splitStatus: "failed", splitError: "Gateway reported the transfer failed" }).where(eq(sales.id, row.id));
        } else result.waiting += 1;
        }),
      );
    }
    if (ready.length === 0) return result;

    const byGame = new Map<string, typeof rows>();
    for (const row of ready) byGame.set(row.gameId, [...(byGame.get(row.gameId) ?? []), row]);

    for (const [gameId, chunks] of byGame) {
      const total = chunks.reduce((sum, r) => sum + BigInt(r.priceUnits), 0n);
      const oldest = Math.min(...chunks.map((r) => r.createdAt.getTime()));
      if (total < minUnits && Date.now() - oldest < maxAgeMs) continue;

      const game = await db.query.games.findFirst({ where: eq(games.id, gameId), columns: { vaultAddress: true } });
      if (!game?.vaultAddress) {
        logger.error({ gameId }, "trial revenue has nowhere to go: the game has no vault");
        continue;
      }
      try {
        const txHash = await relayToVault(game.vaultAddress as Address, total);
        await db
          .update(sales)
          .set({ splitStatus: "distributed" })
          .where(and(inArray(sales.id, chunks.map((c) => c.id)), eq(sales.splitStatus, "pending")));
        result.relayed.push({ gameId, units: total.toString(), txHash });
        logger.info({ gameId, vault: game.vaultAddress, units: total.toString(), chunks: chunks.length, txHash }, "trial revenue relayed to the game's vault");
      } catch (err) {
        logger.error({ err: String(err), gameId, units: total.toString() }, "relaying trial revenue failed; it stays pending and will be retried");
      }
    }
  } catch (err) {
    logger.error({ err: String(err) }, "trial relay pass failed");
  } finally {
    running = false;
  }
  return result;
}

/** Withdraw `units` from the operator's Gateway balance with `vault` as the recipient, and redeem it. */
async function relayToVault(vault: Address, units: bigint): Promise<Hex> {
  await ensureFloat(units + MAX_FEE_UNITS);
  const intent = await buildGatewayBurnIntent(operator().address, vault, units, MAX_FEE_UNITS);
  const signature = await operator().signTypedData(gatewayBurnIntentTypedData(intent));
  const outcome = await submitGatewayBurnIntent(intent, signature);
  if (outcome.status === "failed") throw new Error(`Gateway refused the relay: ${outcome.message}`);
  return submitGatewayMint(outcome.attestation, outcome.signature);
}

/**
 * Keep enough in the operator's Gateway balance to cover a relay plus Circle's
 * fee, depositing from the operator's own wallet when it is short. This is what
 * makes the relay hands-off: without a float the very first relay is refused,
 * because the balance holds exactly the revenue and the fee comes out on top.
 */
async function ensureFloat(needUnits: bigint): Promise<void> {
  const have = await gatewayAvailableUnits(operator().address);
  if (have >= needUnits) return;

  const deposit = needUnits - have + FLOAT_TARGET_UNITS;
  const wallet = await publicClient().getBalance({ address: operator().address });
  if (wallet < (deposit + OPERATOR_RESERVE_UNITS) * 10n ** 12n) {
    throw new Error("the operator's Gateway float is low and its wallet cannot cover a top-up; fund the operator");
  }
  const gatewayWallet = await gatewayWalletAddress();
  const write = async (to: Address, functionName: "approve" | "deposit", args: readonly unknown[]) => {
    const data = encodeFunctionData({ abi: depositAbi, functionName, args: args as never });
    const hash = await walletClient().sendTransaction({ account: operator(), chain: arcChain(), to, data, ...(await feeOverrides()) });
    await confirm(hash);
  };
  await write(USDC_ADDRESS, "approve", [gatewayWallet, deposit]);
  await write(gatewayWallet, "deposit", [USDC_ADDRESS, deposit]);
  logger.info({ depositedUnits: deposit.toString() }, "topped up the operator's Gateway float");

  // Mined is not credited: Gateway's own balance trails the chain by a few seconds.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if ((await gatewayAvailableUnits(operator().address)) >= needUnits) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("the float deposit has not shown up in Gateway yet; will retry next pass");
}
