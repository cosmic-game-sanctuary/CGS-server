import { eq } from "drizzle-orm";
import type { Address } from "viem";
import { db } from "../../db/client.js";
import { games, splits } from "../../db/schema.js";
import { gameIdFor, getListing, publishListing } from "../arc/registry.js";
import { deployVault, toBasisPoints } from "../arc/vaultFactory.js";
import logger from "../../utils/logger.utils.js";

type Game = typeof games.$inferSelect;

/**
 * Putting a game on sale, which on Arc means two contract calls.
 *
 * `VaultFactory.deploy` creates the contract that will hold this game's money
 * and divide it, and `GameRegistry.publish` makes the listing public — the
 * second is what the wishlist agent reads, so a game that is published in our
 * database and not in the registry is a game the agent cannot see. That is the
 * one thing in this project not to get wrong.
 *
 * **The chain goes first and the database last**, which reverses what the HCS
 * version did. Announcing before saving used to risk publishing a price nobody
 * could buy at, and the fix was to save first. That reasoning does not survive
 * here, because the publish route refuses to run on a game that is no longer a
 * draft: saving first and then failing on chain would leave the game marked
 * published, unlisted, and impossible to retry. Both contract calls converge on
 * a retry instead — the factory returns the vault it already made, and a
 * registry that already has the listing is treated as success — so the window
 * where the chain is ahead of the database is one local UPDATE wide, and a
 * retry closes it.
 */
export type PublishResult = {
  vault: Address;
  /** Null when the vault already existed, i.e. this is a retry. */
  vaultTxHash: string | null;
  /** Null when the listing was already on the registry. */
  listingTxHash: string | null;
};

export async function publishOnChain(game: Game): Promise<PublishResult> {
  const rows = await db.query.splits.findMany({ where: eq(splits.gameId, game.id) });
  if (rows.length === 0) throw new Error(`game ${game.id} has no splits, so it has no payees`);

  // Addresses are guaranteed by resolveSplitRecipients, which pre-generates one
  // for an invited collaborator. A null here means a row written before that
  // was true, and it cannot be papered over: the vault is immutable, so naming
  // the wrong address now is permanent.
  const unaddressed = rows.filter((r) => !r.wallet);
  if (unaddressed.length > 0) {
    throw new Error(
      `cannot publish: no payout address for ${unaddressed.map((r) => r.handle).join(", ")}. ` +
        `The split is fixed in a contract at publish, so every payee needs an address first.`,
    );
  }

  const total = rows.reduce((sum, r) => sum + r.pct, 0);
  if (total !== 100) throw new Error(`splits total ${total}, not 100`);

  const gameId = gameIdFor(game.id);
  const recipients = toBasisPoints(rows.map((r) => ({ wallet: r.wallet!, pct: r.pct })));

  const { vault, txHash: vaultTxHash, alreadyExisted } = await deployVault(gameId, recipients);
  if (alreadyExisted) {
    logger.info({ gameId: game.id, vault }, "vault already existed — finishing an interrupted publish");
  }

  const existing = await getListing(gameId);
  if (existing.published) {
    // Already listed, so this is a retry whose first attempt got further than
    // it reported. Nothing to re-emit; the listing is the listing.
    if (existing.vault !== vault) {
      throw new Error(
        `game ${game.id} is already listed against vault ${existing.vault}, not ${vault}. ` +
          `Refusing to continue: the listed vault is the one buyers pay.`,
      );
    }
    return { vault, vaultTxHash, listingTxHash: null };
  }

  const { txHash: listingTxHash } = await publishListing({
    gameId,
    slug: game.slug,
    priceUnits: BigInt(game.priceUnits),
    vault,
    buildCid: game.buildCid ?? "",
  });

  return { vault, vaultTxHash, listingTxHash };
}
