import { and, eq } from "drizzle-orm";
import {
  TokenMintTransaction,
  TransferTransaction,
  TokenId,
  Hbar,
  AccountId,
} from "@hiero-ledger/sdk";
import { db } from "../../db/client.js";
import {
  games,
  splits,
  gameKeys,
  notifications,
  studios,
  studioMembers,
  sales,
  pendingPayouts,
} from "../../db/schema.js";
import client from "../hedera/client.js";
import { submitTopicMessage } from "../hedera/hcs.js";
import { getAccountByEvmAddress } from "../hedera/mirror.js";
import { env } from "../../config/env.js";
import logger from "../../utils/logger.utils.js";

type Game = typeof games.$inferSelect;

// Everything that happens AFTER the buyer's payment has settled. Deliberately
// off the critical path: settlement is the moment the buyer is entitled to the
// game, so the HTTP response returns immediately and this runs in the
// background. A failure here never costs the buyer their purchase — the
// payment is already final and provable on-chain, and `game_keys.mint_status`
// records what still needs retrying.
export async function fulfilPurchase(game: Game, buyerAccountId: string, settlementTxId: string) {
  const [sale] = await db
    .insert(sales)
    .values({
      gameId: game.id,
      buyerAccountId,
      priceUnits: game.priceUnits,
      priceAsset: game.priceAsset,
      settlementTxId,
    })
    .returning();

  const [key] = await db
    .insert(gameKeys)
    .values({
      tokenId: game.htsTokenId!,
      gameId: game.id,
      ownerAccountId: buyerAccountId,
      mintStatus: "pending",
    })
    .returning();

  try {
    const serial = await mintAndTransferKey(game, buyerAccountId);
    await db
      .update(gameKeys)
      .set({ serial, mintStatus: "confirmed", mintedAt: new Date(), txId: settlementTxId })
      .where(eq(gameKeys.id, key!.id));
  } catch (err) {
    logger.error({ err, gameId: game.id, buyerAccountId }, "GameKey mint failed");
    await db.update(gameKeys).set({ mintStatus: "failed" }).where(eq(gameKeys.id, key!.id));
  }

  // the split and the sale log are independent of the mint — a failed mint
  // shouldn't stop the devs getting paid, and vice versa. A failed split is
  // recorded on the sale row rather than just logged — scripts/retry-failed-splits.ts
  // is what actually retries it. There was no way to retry this before Stage 4;
  // it just logged an error and moved on.
  await runSplitDistribution(sale!.id, game);

  await submitTopicMessage(env.HCS_SALES_TOPIC!, {
    gameId: game.id,
    slug: game.slug,
    buyer: buyerAccountId,
    amountUnits: game.priceUnits,
    asset: game.priceAsset,
    settlementTxId,
    at: new Date().toISOString(),
  })
    .then((hcsTxId) => db.update(sales).set({ hcsSaleTxId: hcsTxId }).where(eq(sales.id, sale!.id)))
    .catch((err) => logger.error({ err, gameId: game.id }, "HCS sale log failed"));

  await notifyStudio(game).catch(() => {});
}

async function runSplitDistribution(saleId: string, game: Game) {
  if (game.priceUnits <= 0) {
    // nothing owed on a free game — there's nothing to retry, so it's not
    // "pending" forever, it's just done.
    await db.update(sales).set({ splitStatus: "distributed" }).where(eq(sales.id, saleId));
    return;
  }
  try {
    const { held } = await distributeSplits(game, saleId);
    // "partial" rather than "failed": the money that could move, moved. What
    // is left belongs to someone who hasn't claimed their invite, and it is
    // recorded in pending_payouts rather than lost.
    await db
      .update(sales)
      .set({ splitStatus: held > 0 ? "partial" : "distributed" })
      .where(eq(sales.id, saleId));
  } catch (err) {
    logger.error({ err, gameId: game.id, saleId }, "split distribution failed");
    const message = err instanceof Error ? err.message : String(err);
    await db.update(sales).set({ splitStatus: "failed", splitError: message }).where(eq(sales.id, saleId));
  }
}

async function mintAndTransferKey(game: Game, buyerAccountId: string): Promise<number> {
  const tokenId = TokenId.fromString(game.htsTokenId!);

  const mint = await new TokenMintTransaction()
    .setTokenId(tokenId)
    .setMetadata([new TextEncoder().encode(`cgs:${game.slug}`)])
    .execute(client);
  const receipt = await mint.getReceipt(client);

  const serial = receipt.serials[0];
  if (!serial) throw new Error("mint returned no serial");

  // treasury (the operator) holds the freshly minted serial; move it to the
  // buyer. Privy wallets are alias-created so they have unlimited
  // auto-association under HIP-904 and need no association step.
  const transfer = await new TransferTransaction()
    .addNftTransfer(tokenId, serial, env.HEDERA_OPERATOR_ID, buyerAccountId)
    .execute(client);
  await transfer.getReceipt(client);

  return serial.toNumber();
}

/**
 * Everyone who can be paid, paid in one transaction. Everyone who can't,
 * recorded.
 *
 * The atomicity that matters is still there: the people being paid *now* are
 * paid together or not at all, which is the "nobody chases a teammate for
 * their share" promise. What changed is who counts as a recipient. A split can
 * name someone who has never opened CGS — that is the entire point of adding a
 * collaborator by email — and such a person has no Hedera account for the
 * network to pay. Treating that as a failure of the whole distribution meant
 * one unclaimed invite stopped everybody's money, which is the opposite of
 * what the product says out loud.
 *
 * So their share is held instead, and settled the moment they accept. Nothing
 * is lost and nothing is stranded: the amounts still total `priceUnits`, the
 * held part simply stays in the operator account until it has somewhere to go.
 */
async function distributeSplits(game: Game, saleId: string): Promise<{ paid: number; held: number }> {
  if (game.priceUnits <= 0) return { paid: 0, held: 0 };

  const rows = await db.query.splits.findMany({ where: eq(splits.gameId, game.id) });
  if (rows.length === 0) return { paid: 0, held: 0 };

  // Amounts are worked out across every share first, so the split maths is
  // unchanged by who happens to be payable — the remainder still lands on the
  // largest share rather than shifting to whoever has an account today.
  const shares = rows.map((row) => ({
    row,
    amount: Math.floor((game.priceUnits * row.pct) / 100),
  }));

  // integer division leaves a remainder of at most (recipients - 1) units;
  // give it to the largest share rather than letting it strand in the
  // platform account.
  const allocated = shares.reduce((sum, s) => sum + s.amount, 0);
  const remainder = game.priceUnits - allocated;
  if (remainder > 0) {
    const largest = shares.reduce((a, b) => (b.amount > a.amount ? b : a));
    largest.amount += remainder;
  }

  const payable: { accountId: string; amount: number }[] = [];
  const held: { splitId: string; studioMemberId: string | null; amount: number; reason: string }[] = [];

  for (const share of shares) {
    const accountId = share.row.wallet ? await resolveAccountId(share.row.wallet) : null;
    if (accountId) {
      payable.push({ accountId, amount: share.amount });
    } else {
      held.push({
        splitId: share.row.id,
        studioMemberId: share.row.studioMemberId,
        amount: share.amount,
        reason: share.row.wallet
          ? `${share.row.handle}'s wallet has no Hedera account yet`
          : `${share.row.handle} hasn't claimed their invite yet`,
      });
    }
  }

  if (payable.length > 0) {
    const total = payable.reduce((sum, r) => sum + r.amount, 0);
    const tx = new TransferTransaction();
    if (game.priceAsset === "0.0.0") {
      tx.addHbarTransfer(env.HEDERA_OPERATOR_ID, Hbar.fromTinybars(-total));
      for (const r of payable) tx.addHbarTransfer(r.accountId, Hbar.fromTinybars(r.amount));
    } else {
      const tokenId = TokenId.fromString(game.priceAsset);
      tx.addTokenTransfer(tokenId, env.HEDERA_OPERATOR_ID, -total);
      for (const r of payable) tx.addTokenTransfer(tokenId, r.accountId, r.amount);
    }
    const response = await tx.execute(client);
    await response.getReceipt(client);
  }

  if (held.length > 0) {
    await db.insert(pendingPayouts).values(
      held.map((h) => ({
        saleId,
        gameId: game.id,
        splitId: h.splitId,
        studioMemberId: h.studioMemberId,
        amountUnits: h.amount,
        asset: game.priceAsset,
        reason: h.reason,
      })),
    );
    logger.info(
      { gameId: game.id, saleId, held: held.length },
      "some shares are held pending an invite being claimed",
    );
  }

  return { paid: payable.length, held: held.length };
}

/**
 * Pay out everything held for one person, now that they have an account.
 *
 * Called when an invite is accepted. Each payout is settled on its own rather
 * than batched: they belong to different sales, and one bad row should not
 * strand the rest.
 */
export async function settleHeldPayouts(studioMemberId: string, accountId: string): Promise<number> {
  const owed = await db.query.pendingPayouts.findMany({
    where: and(eq(pendingPayouts.studioMemberId, studioMemberId), eq(pendingPayouts.status, "held")),
  });
  if (owed.length === 0) return 0;

  let settled = 0;
  for (const payout of owed) {
    try {
      const tx = new TransferTransaction();
      if (payout.asset === "0.0.0") {
        tx.addHbarTransfer(env.HEDERA_OPERATOR_ID, Hbar.fromTinybars(-payout.amountUnits));
        tx.addHbarTransfer(accountId, Hbar.fromTinybars(payout.amountUnits));
      } else {
        const tokenId = TokenId.fromString(payout.asset);
        tx.addTokenTransfer(tokenId, env.HEDERA_OPERATOR_ID, -payout.amountUnits);
        tx.addTokenTransfer(tokenId, accountId, payout.amountUnits);
      }
      const response = await tx.execute(client);
      await response.getReceipt(client);

      await db
        .update(pendingPayouts)
        .set({ status: "settled", settledAt: new Date(), settlementTxId: response.transactionId.toString() })
        .where(eq(pendingPayouts.id, payout.id));
      settled += 1;

      // The sale is fully distributed once nothing is still held against it.
      const stillHeld = await db.query.pendingPayouts.findMany({
        where: and(eq(pendingPayouts.saleId, payout.saleId), eq(pendingPayouts.status, "held")),
        columns: { id: true },
      });
      if (stillHeld.length === 0) {
        await db.update(sales).set({ splitStatus: "distributed" }).where(eq(sales.id, payout.saleId));
      }
    } catch (err) {
      logger.error({ err, payoutId: payout.id }, "held payout failed to settle");
      const message = err instanceof Error ? err.message : String(err);
      await db.update(pendingPayouts).set({ status: "failed", reason: message }).where(eq(pendingPayouts.id, payout.id));
    }
  }

  return settled;
}

async function resolveAccountId(wallet: string): Promise<string | null> {
  if (/^\d+\.\d+\.\d+$/.test(wallet)) return wallet;
  const account = await getAccountByEvmAddress(wallet);
  return account?.account ?? null;
}

async function notifyStudio(game: Game) {
  const studio = await db.query.studios.findFirst({ where: eq(studios.id, game.studioId) });
  const members = await db.query.studioMembers.findMany({
    where: eq(studioMembers.studioId, game.studioId),
  });
  const userIds = new Set(members.map((m) => m.userId).filter((id): id is string => id !== null));
  userIds.add(studio!.ownerUserId);

  // Each person is told what *they* earned, not what the game sold for. The
  // payload used to carry the full price to everyone, so a row reading "your
  // share is in your wallet" next to it was wrong for every collaborator on a
  // split — and quietly flattering to whoever read it.
  const gameSplits = await db.query.splits.findMany({ where: eq(splits.gameId, game.id) });
  const handleByUser = new Map(
    members.filter((m) => m.userId).map((m) => [m.userId!, m.handle] as const),
  );
  const pctByHandle = new Map(gameSplits.map((s) => [s.handle, s.pct] as const));

  await db.insert(notifications).values(
    [...userIds].map((userId) => {
      const pct = pctByHandle.get(handleByUser.get(userId) ?? "") ?? null;
      return {
        userId,
        type: "sale" as const,
        payload: {
          gameId: game.id,
          slug: game.slug,
          title: game.title,
          priceUnits: game.priceUnits,
          priceAsset: game.priceAsset,
          // null when this person isn't on the splits — a studio owner who
          // credited the work to other people still wants to know it sold.
          sharePct: pct,
          shareUnits: pct === null ? null : Math.floor((game.priceUnits * pct) / 100),
        },
      };
    }),
  );
}

export { resolveAccountId, distributeSplits };
