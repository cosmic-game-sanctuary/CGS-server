import { eq } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { db } from "../../db/client.js";
import { games, gameKeys, sales } from "../../db/schema.js";
import { keyAddress } from "../arc/client.js";
import { mintKey, ownsGame } from "../arc/keys.js";
import { gameIdFor } from "../arc/registry.js";
import { notifyStudio } from "./saleNotice.js";
import logger from "../../utils/logger.utils.js";

type Game = typeof games.$inferSelect;

/**
 * Everything that happens after an Arc payment has settled.
 *
 * Much smaller than its Hedera counterpart (`fulfil.ts`), and the difference is
 * the point rather than a simplification: **there is no money for this server to
 * move.** The buyer's authorization paid the game's `SplitVault` directly, so by
 * the time this runs the split has already been enforced by a contract that has
 * no function capable of doing otherwise. Three things that existed only to
 * carry that burden are gone:
 *
 *   `distributeSplits` — nothing to distribute. The vault holds each payee's
 *   share and `claim()` is theirs to call.
 *
 *   `pending_payouts` — a share belonging to someone who hasn't accepted their
 *   invite simply accrues in the vault against the address recorded at publish,
 *   claimable forever, with no action from us and no row to hold it.
 *
 *   the HCS sale message — the settlement transaction *is* the public record,
 *   on an explorer anyone can read, so announcing it separately would be us
 *   restating what the chain already says.
 *
 * What is left is the mint, the sale row, and telling the studio.
 */
export async function fulfilArcPurchase(input: {
  game: Game;
  /** Who gets the GameKey. For an agent's purchase, the person it works for. */
  ownerAddress: Address;
  /** The address the money actually left — the agent's, when one paid. */
  payerAddress: Address;
  settlementTx: Hex;
  /** Atomic USDC units actually settled, never the listing price read again. */
  amountUnits: number;
  kind: "purchase" | "trial_chunk";
  creditAppliedUnits?: number;
}): Promise<void> {
  const { game, ownerAddress, payerAddress, settlementTx, amountUnits, kind } = input;

  // The sale row, and for a real purchase a key row, before anything chain-side
  // is attempted. They are what says this person paid: the download route hands
  // back a build the instant the request responds and that request reads the
  // record, so this cannot be deferred to the background.
  //
  // A trial chunk gets no key — five minutes of access is not ownership, and
  // minting for it would make a chunk cost as much chain work as the game.
  const [sale] = await db
    .insert(sales)
    .values({
      gameId: game.id,
      buyerAccountId: ownerAddress,
      priceUnits: amountUnits,
      priceAsset: game.priceAsset,
      settlementTxId: settlementTx,
      kind,
      creditAppliedUnits: kind === "purchase" ? (input.creditAppliedUnits ?? 0) : 0,
      // Settled by the vault at the moment of payment, which is strictly
      // stronger than us having sent the transfers ourselves — there was never a
      // window in which the money sat somewhere we controlled. Nothing retries
      // this and nothing can fail it.
      splitStatus: "distributed",
    })
    .returning();

  const key =
    kind === "purchase"
      ? (
          await db
            .insert(gameKeys)
            .values({
              // One ERC-721 collection for every game, so the "token" is the
              // contract and `serial` is the ERC-721 tokenId within it.
              tokenId: keyAddress(),
              gameId: game.id,
              ownerAccountId: ownerAddress,
              mintStatus: "pending",
            })
            .returning()
        )[0]
      : undefined;

  if (!key) return;

  // Off the critical path deliberately: settlement is the moment the buyer is
  // entitled to the game, so a slow or failed mint must never cost them their
  // purchase. `mint_status` records what still needs retrying.
  void mintGameKey(game, ownerAddress, key.id).catch((err) =>
    logger.error({ err, gameId: game.id, ownerAddress }, "Arc GameKey mint failed outright"),
  );

  if (kind === "purchase") {
    await notifyStudio(game, sale!.priceUnits, payerAddress).catch((err) =>
      logger.error({ err, gameId: game.id }, "sale notification failed"),
    );
  }
}

async function mintGameKey(game: Game, owner: Address, keyRowId: string): Promise<void> {
  const gameId = gameIdFor(game.id);
  try {
    // A retry must never issue a second key for the same game. Asked of the
    // chain rather than of our own table, because the table is the thing that
    // might be wrong — a mint that landed while the row still said `pending` is
    // exactly the case a retry exists for.
    const existing = await ownsGame(owner, gameId);
    if (existing.owned) {
      await db
        .update(gameKeys)
        .set({ serial: Number(existing.tokenId), mintStatus: "confirmed", mintedAt: new Date() })
        .where(eq(gameKeys.id, keyRowId));
      return;
    }

    const { tokenId, txHash } = await mintKey(owner, gameId);
    await db
      .update(gameKeys)
      .set({ serial: Number(tokenId), mintStatus: "confirmed", mintedAt: new Date(), txId: txHash })
      .where(eq(gameKeys.id, keyRowId));
  } catch (err) {
    logger.error({ err, gameId: game.id, owner }, "Arc GameKey mint failed");
    await db.update(gameKeys).set({ mintStatus: "failed" }).where(eq(gameKeys.id, keyRowId));
  }
}
