import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { games, gamePriceChanges } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { submitTopicMessage } from "../hedera/hcs.js";
import logger from "../../utils/logger.utils.js";

type Game = typeof games.$inferSelect;

/**
 * The public listings topic, and the rule about what goes on it.
 *
 * A publish is not a notification that a game was listed — the HCS message
 * *is* the listing. Everything that changes what is on offer belongs here for
 * the same reason: the wishlist agent reads this topic through the Mirror Node
 * and nothing else, so a price that only ever changed in our database is a
 * price the agent can never see. That is the one thing in this project not to
 * get wrong.
 *
 * Every message carries `type`. Before this there was only one kind of message
 * and a reader could assume any message meant "for sale at priceUnits" — which
 * would make a delisting look like an offer. Readers written against the old
 * shape still work: the fields they read are all still there, on the messages
 * where they still mean something.
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

/** Events that state a price someone could act on. A delisting is not one. */
const PRICE_BEARING: ListingEvent[] = ["listed", "price_changed", "build_updated", "relisted"];

/**
 * Put a listing event on the topic. Returns the transaction id, or null if the
 * write failed.
 *
 * Deliberately does not throw. The caller has already changed the database by
 * the time this runs, and that order is not an accident: announcing first and
 * then failing to save would publish a price nobody can actually buy at, and
 * the agent would fire against a game still charging the old one. Saving first
 * and failing to announce is the harmless direction — the change is real, it
 * is just not public yet, and `listings:retry` will send it.
 */
export async function announce(
  game: Game,
  type: ListingEvent,
  extra: Record<string, unknown> = {},
): Promise<string | null> {
  if (!env.HCS_LISTINGS_TOPIC) {
    logger.warn({ gameId: game.id, type }, "no listings topic configured — nothing announced");
    return null;
  }

  const priced = PRICE_BEARING.includes(type);

  try {
    return await submitTopicMessage(env.HCS_LISTINGS_TOPIC, {
      type,
      gameId: game.id,
      slug: game.slug,
      title: game.title,
      studioId: game.studioId,
      // Null rather than absent on a delisting, so a reader that looks for the
      // field finds an explicit "not for sale" instead of a stale number.
      priceUnits: priced ? game.priceUnits : null,
      priceAsset: game.priceAsset,
      tokenId: game.htsTokenId,
      buildCid: game.buildCid,
      buildVersion: game.buildVersion,
      publishedAt: game.publishedAt,
      at: new Date().toISOString(),
      ...extra,
    });
  } catch (err) {
    logger.error({ err, gameId: game.id, type }, "announcing to the listings topic failed");
    return null;
  }
}

/**
 * Change the price, record it, and tell the topic.
 *
 * The history row is written whether or not the announcement lands, with
 * `hcsTxId` null when it didn't — that null is what `listings:retry` looks for.
 * Silently dropping the change would leave the price history with a gap and no
 * way to know one existed.
 */
export async function changePrice(game: Game, toUnits: number, byUserId: string) {
  const fromUnits = game.priceUnits;

  const [updated] = await db
    .update(games)
    .set({ priceUnits: toUnits, updatedAt: new Date() })
    .where(eq(games.id, game.id))
    .returning();

  // A draft has never been on the topic, so there is nothing to correct there
  // and no agent watching it. Its price history starts at publish.
  const hcsTxId =
    updated!.status === "published" ? await announce(updated!, "price_changed", { fromUnits }) : null;

  const [change] = await db
    .insert(gamePriceChanges)
    .values({
      gameId: game.id,
      fromUnits,
      toUnits,
      asset: game.priceAsset,
      changedByUserId: byUserId,
      hcsTxId,
    })
    .returning();

  return { game: updated!, change: change!, announced: hcsTxId !== null };
}

/**
 * Price history, newest first, each row naming the message that announced it.
 *
 * The point of returning `hcsTxId` is that it makes the list checkable by
 * someone who does not trust this table: the message is on a public topic and
 * the Mirror Node will serve it to anyone. No storefront that owns its own
 * price history can offer that.
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
      asset: r.asset,
      at: r.createdAt,
      hcsTxId: r.hcsTxId,
      topicId: env.HCS_LISTINGS_TOPIC ?? null,
    }));
}
