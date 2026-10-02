import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { games, gamePriceChanges } from "../../db/schema.js";
import { assetDecimals, toDisplayAmount } from "../../lib/display.js";
import { explorerTxUrl } from "../arc/client.js";
import {
  announceBuild,
  announceDemand,
  announcePrice,
  delistListing,
  gameIdFor,
  relistListing,
} from "../arc/registry.js";
import logger from "../../utils/logger.utils.js";

type Game = typeof games.$inferSelect;

/**
 * The public listing log, and the rule about what goes on it.
 *
 * A publish is not a notification that a game was listed — the `Listed` event
 * *is* the listing. Everything that changes what is on offer belongs here for
 * the same reason: the wishlist agent reads `GameRegistry`'s events through
 * `eth_getLogs` and nothing else, so a price that only ever changed in our
 * database is a price the agent can never see. That is the one thing in this
 * project not to get wrong.
 *
 * This used to be an HCS topic on Hedera, and the rule it enforced is
 * unchanged — only the log moved. What did change is that the registry has a
 * *function per kind of change* rather than one free-form message, so a reader
 * can no longer mistake a delisting for an offer: there is no price field on
 * `Delisted` to misread. The `type` switch below is what maps our one
 * announcement helper onto them.
 */
export type ListingEvent =
  | "listed"
  | "price_changed"
  | "build_updated"
  | "delisted"
  | "relisted"
  // How many people are waiting for this game. Public everywhere else it is
  // private — see services/games/wishlist.ts#announceDemandIfMilestone.
  | "demand";

/**
 * Events that state a price someone could act on. A delisting is not one.
 *
 * Only used for the price history row now — the registry's own events carry
 * whichever fields their kind actually has.
 */
const PRICE_BEARING: ListingEvent[] = ["listed", "price_changed", "build_updated", "relisted"];

/**
 * Record a listing change on `GameRegistry`. Returns the transaction hash, or
 * null if the write failed.
 *
 * Deliberately does not throw. The caller has already changed the database by
 * the time this runs, and that order is not an accident for *changes*:
 * announcing first and then failing to save would publish a price nobody can
 * actually buy at, and the agent would fire against a game still charging the
 * old one. Saving first and failing to announce is the harmless direction — the
 * change is real, it is just not public yet, and `listings:retry` will send it.
 *
 * (Publishing is the exception and goes the other way round, because a publish
 * cannot be retried once the row says published — see
 * services/games/publishArc.ts.)
 */
export async function announce(
  game: Game,
  type: ListingEvent,
  extra: Record<string, unknown> = {},
): Promise<string | null> {
  const gameId = gameIdFor(game.id);

  try {
    switch (type) {
      case "listed":
        // Emitted by publishOnChain, which needs the vault address this
        // function has no business deciding. Reaching here means a caller
        // announced a publish the long way round.
        throw new Error("a publish is announced by publishOnChain, not by announce()");

      case "price_changed": {
        // `fromUnits` comes from the caller because the row has already been
        // updated by the time this runs — the old price is gone from the game.
        const fromUnits = BigInt((extra.fromUnits as number | undefined) ?? game.priceUnits);
        const endsAt = extra.endsAt ? BigInt(Math.floor(new Date(extra.endsAt as string).getTime() / 1000)) : 0n;
        const { txHash } = await announcePrice(gameId, fromUnits, BigInt(game.priceUnits), endsAt);
        return txHash;
      }

      case "build_updated": {
        const { txHash } = await announceBuild(gameId, game.buildVersion, game.buildCid ?? "");
        return txHash;
      }

      case "delisted": {
        const { txHash } = await delistListing(gameId);
        return txHash;
      }

      case "relisted": {
        const { txHash } = await relistListing(gameId, BigInt(game.priceUnits));
        return txHash;
      }

      case "demand": {
        const { txHash } = await announceDemand(
          gameId,
          Number(extra.wishlistCount ?? 0),
          Number(extra.milestone ?? 0),
        );
        return txHash;
      }
    }
  } catch (err) {
    logger.error({ err, gameId: game.id, type }, "recording the listing change on GameRegistry failed");
    return null;
  }
}

/**
 * Change the price, record it, and tell the topic.
 *
 * The history row is written whether or not the announcement lands, with
 * `chainTxHash` null when it didn't — that null is what `listings:retry` looks for.
 * Silently dropping the change would leave the price history with a gap and no
 * way to know one existed.
 */
export async function changePrice(
  game: Game,
  toUnits: number,
  // Null when nobody pressed anything — a promotion reverting on its own
  // schedule is a real price change with no author.
  byUserId: string | null,
  // Extra fields for the topic message. A promotional change carries its
  // `endsAt`, which is the whole reason anything reading the topic can reason
  // about deadlines rather than guessing — see services/games/promotions.ts.
  announceExtra: Record<string, unknown> = {},
) {
  const fromUnits = game.priceUnits;

  const [updated] = await db
    .update(games)
    .set({ priceUnits: toUnits, updatedAt: new Date() })
    .where(eq(games.id, game.id))
    .returning();

  // A draft has never been on the topic, so there is nothing to correct there
  // and no agent watching it. Its price history starts at publish.
  const chainTxHash =
    updated!.status === "published"
      ? await announce(updated!, "price_changed", { fromUnits, ...announceExtra })
      : null;

  const [change] = await db
    .insert(gamePriceChanges)
    .values({
      gameId: game.id,
      fromUnits,
      toUnits,
      asset: game.priceAsset,
      changedByUserId: byUserId,
      chainTxHash,
    })
    .returning();

  return { game: updated!, change: change!, announced: chainTxHash !== null };
}

/**
 * Price history, newest first, each row naming the transaction that recorded it.
 *
 * The point of returning `chainTxHash` is that it makes the list checkable by
 * someone who does not trust this table: the event is on a public chain and the
 * explorer will serve it to anyone. No storefront that owns its own price
 * history can offer that.
 */
export async function priceHistory(game: Game) {
  const rows = await db.query.gamePriceChanges.findMany({
    where: eq(gamePriceChanges.gameId, game.id),
  });

  return rows
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((r) => ({
      fromUnits: r.fromUnits,
      toUnits: r.toUnits,
      // The display pair belongs here rather than in the route. It used to be
      // added by GET /:id/price-history and *not* by GET /:id/manage, so the
      // same row arrived in two different shapes depending on which endpoint
      // you asked — which cost the frontend an hour of debugging a blank
      // screen. One shape for one thing, produced in one place.
      fromUsd: toDisplayAmount(r.fromUnits, r.asset),
      toUsd: toDisplayAmount(r.toUnits, r.asset),
      asset: r.asset,
      assetDecimals: assetDecimals(r.asset),
      at: r.createdAt,
      chainTxHash: r.chainTxHash,
      explorerUrl: r.chainTxHash ? explorerTxUrl(r.chainTxHash) : null,
    }));
}
