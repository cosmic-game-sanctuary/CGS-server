import { eq } from "drizzle-orm";
import { getAddress, type Address } from "viem";
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
  /**
   * An on-chain transaction hash for a normal settlement. A trial chunk
   * settled through Circle Gateway (Stage 7) has no transaction yet at this
   * point — pass its transfer id via `gatewayTransferId` instead and this
   * field is used only as the (temporary) human-readable record.
   */
  settlementTx: string;
  /** Atomic USDC units actually settled, never the listing price read again. */
  amountUnits: number;
  kind: "purchase" | "trial_chunk";
  creditAppliedUnits?: number;
  /**
   * Set only when `settlementTx` is a Circle Gateway transfer id, not a
   * transaction hash — see services/arc/x402/gateway.ts. The money for this
   * sale is not yet in the vault; it lands whenever Gateway's next batch runs.
   */
  gatewayTransferId?: string;
}): Promise<void> {
  const { game, payerAddress, settlementTx, amountUnits, kind, gatewayTransferId } = input;
  // Canonical EIP-55 case, regardless of what case the settlement path handed
  // back — Circle Gateway's own `/settle` response echoes the payer address
  // lowercased (measured directly, Stage 7), and nothing downstream should
  // have to know that. `trialChunksFor` matches `buyerAccountId` by exact
  // string equality against a signed-in user's (checksummed) `evmAddress`, so
  // a lowercase row here would silently never be found as that buyer's own
  // trial credit.
  const ownerAddress = getAddress(input.ownerAddress);

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
      gatewayTransferId: gatewayTransferId ?? null,
      kind,
      creditAppliedUnits: kind === "purchase" ? (input.creditAppliedUnits ?? 0) : 0,
      // Settled by the vault at the moment of payment, which is strictly
      // stronger than us having sent the transfers ourselves — there was never
      // a window in which the money sat somewhere we controlled. Not true for
      // a Gateway chunk: Circle credits it immediately but the vault only sees
      // it once a batch lands, so that one case is left at the column's own
      // "pending" default instead of being asserted settled.
      splitStatus: gatewayTransferId ? "pending" : "distributed",
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
