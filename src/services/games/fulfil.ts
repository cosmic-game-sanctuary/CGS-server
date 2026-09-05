import { eq } from "drizzle-orm";
import {
  TokenMintTransaction,
  TransferTransaction,
  TokenId,
  Hbar,
  AccountId,
} from "@hiero-ledger/sdk";
import { db } from "../../db/client.js";
import { games, splits, gameKeys, notifications, studios, studioMembers, sales } from "../../db/schema.js";
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
    await distributeSplits(game);
    await db.update(sales).set({ splitStatus: "distributed" }).where(eq(sales.id, saleId));
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

// One transaction, every recipient, or nobody gets paid. That atomicity is
// the "nobody chases a teammate for their share" promise, enforced by the
// network rather than by us.
async function distributeSplits(game: Game) {
  if (game.priceUnits <= 0) return;

  const rows = await db.query.splits.findMany({ where: eq(splits.gameId, game.id) });
  if (rows.length === 0) return;

  const recipients: { accountId: string; amount: number }[] = [];
  for (const row of rows) {
    const accountId = await resolveAccountId(row.wallet);
    if (!accountId) {
      throw new Error(`split recipient ${row.handle} has no Hedera account yet (${row.wallet})`);
    }
    recipients.push({ accountId, amount: Math.floor((game.priceUnits * row.pct) / 100) });
  }

  // integer division leaves a remainder of at most (recipients - 1) units;
  // give it to the largest share rather than letting it strand in the
  // platform account.
  const distributed = recipients.reduce((sum, r) => sum + r.amount, 0);
  const remainder = game.priceUnits - distributed;
  if (remainder > 0) {
    const largest = recipients.reduce((a, b) => (b.amount > a.amount ? b : a));
    largest.amount += remainder;
  }

  const tx = new TransferTransaction();
  if (game.priceAsset === "0.0.0") {
    tx.addHbarTransfer(env.HEDERA_OPERATOR_ID, Hbar.fromTinybars(-game.priceUnits));
    for (const r of recipients) tx.addHbarTransfer(r.accountId, Hbar.fromTinybars(r.amount));
  } else {
    const tokenId = TokenId.fromString(game.priceAsset);
    tx.addTokenTransfer(tokenId, env.HEDERA_OPERATOR_ID, -game.priceUnits);
    for (const r of recipients) tx.addTokenTransfer(tokenId, r.accountId, r.amount);
  }

  const response = await tx.execute(client);
  await response.getReceipt(client);
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

  await db.insert(notifications).values(
    [...userIds].map((userId) => ({
      userId,
      type: "sale" as const,
      payload: { gameId: game.id, title: game.title, amountUnits: game.priceUnits },
    })),
  );
}

export { resolveAccountId, distributeSplits };
