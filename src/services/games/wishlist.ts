import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { wishlistItems, games, users, notifications, wishlistAgents, gameKeys } from "../../db/schema.js";
import { gatewayUrl } from "../ipfs/pinata.js";
import { assetDecimals, toDisplayAmount } from "../../lib/display.js";
import { emailPriceDrop } from "../email/messages.js";
import { announce } from "./listing.js";
import logger from "../../utils/logger.utils.js";

type Game = typeof games.$inferSelect;

/**
 * Saving a game for later, and being told when it gets cheaper.
 *
 * This was the product's quietest hole. There was a wishlist *agent* — which
 * needs its own wallet, funded, before it does anything — and no wishlist. Most
 * people just want to save a game. Steam's wishlist is the single largest
 * retention mechanic in games retail and it is also how a developer learns
 * demand exists before deciding to discount; we had the rows for it and no
 * purpose attached to them.
 *
 * With this, the agent becomes the paid upgrade of a free thing everyone
 * already understands, rather than the only way to express interest.
 */

/**
 * Counts worth announcing publicly. Starting at 1 is deliberate: a storefront
 * this size would otherwise never cross a threshold, and the first save is
 * genuinely the most informative one a developer gets.
 */
const MILESTONES = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

export async function wishlistCount(gameId: string): Promise<number> {
  const rows = await db.query.wishlistItems.findMany({
    where: eq(wishlistItems.gameId, gameId),
    columns: { id: true },
  });
  return rows.length;
}

/**
 * Add, or do nothing if it is already there.
 *
 * Records the price at the moment of saving, which is the only time it can be
 * captured — there is no recovering "what did this cost when they saved it"
 * afterwards for a game whose price has since moved.
 */
export async function addToWishlist(game: Game, userId: string) {
  const existing = await db.query.wishlistItems.findFirst({
    where: and(eq(wishlistItems.gameId, game.id), eq(wishlistItems.userId, userId)),
  });
  if (existing) return { item: existing, added: false };

  const [item] = await db
    .insert(wishlistItems)
    .values({
      gameId: game.id,
      userId,
      priceUnitsWhenAdded: game.priceUnits,
      priceAsset: game.priceAsset,
    })
    .returning();

  return { item: item!, added: true };
}

export async function removeFromWishlist(gameId: string, userId: string) {
  const existing = await db.query.wishlistItems.findFirst({
    where: and(eq(wishlistItems.gameId, gameId), eq(wishlistItems.userId, userId)),
  });
  if (!existing) return false;
  await db.delete(wishlistItems).where(eq(wishlistItems.id, existing.id));
  return true;
}

/**
 * Put a demand count on the public listings topic when it crosses a milestone.
 *
 * Everywhere else, wishlist numbers are private platform data — it is one of
 * the things Steam will not give away, because knowing what people want before
 * they buy it is the moat. Ours can be a public count anyone can read off the
 * Mirror Node and act on, including the developer deciding whether a discount
 * is worth it. `demandMilestone` on the game is what keeps this to one message
 * per threshold rather than one per save.
 *
 * Not price-bearing: a demand message states interest, not an offer, so nothing
 * watching for a price can mistake it for one.
 */
export async function announceDemandIfMilestone(game: Game): Promise<number | null> {
  if (game.status !== "published") return null;

  const count = await wishlistCount(game.id);
  const reached = MILESTONES.filter((m) => m <= count).pop() ?? 0;
  if (reached <= game.demandMilestone) return null;

  const hcsTxId = await announce(game, "demand", { wishlistCount: count, milestone: reached });
  // Recorded even when the announcement failed, so a topic outage does not turn
  // into the same milestone being retried on every subsequent save.
  await db.update(games).set({ demandMilestone: reached }).where(eq(games.id, game.id));
  logger.info({ gameId: game.id, count, milestone: reached, hcsTxId }, "wishlist demand announced");
  return reached;
}

/**
 * Tell everyone who saved this game that it got cheaper.
 *
 * Called by the route that changes a price rather than from inside
 * `changePrice`, which would make listing.ts and this file import each other.
 * Best-effort throughout: a failed email or a failed notification must not roll
 * back a price change that already happened.
 */
export async function notifyPriceDrop(game: Game, fromUnits: number, toUnits: number) {
  if (toUnits >= fromUnits) return 0;

  const items = await db.query.wishlistItems.findMany({
    where: and(eq(wishlistItems.gameId, game.id), eq(wishlistItems.notifyOnDrop, true)),
  });
  if (items.length === 0) return 0;

  // Someone who already owns it does not need telling it got cheaper. That is
  // the one message guaranteed to annoy rather than help.
  const owners = await db.query.gameKeys.findMany({
    where: and(eq(gameKeys.gameId, game.id), eq(gameKeys.mintStatus, "confirmed")),
    columns: { ownerAccountId: true },
  });
  const ownerAccounts = new Set(owners.map((o) => o.ownerAccountId));

  const people = await db.query.users.findMany({
    where: inArray(users.id, items.map((i) => i.userId)),
    columns: { id: true, email: true, hederaAccountId: true },
  });
  const byId = new Map(people.map((p) => [p.id, p]));

  const recipients = items.filter((i) => {
    const person = byId.get(i.userId);
    return person && !(person.hederaAccountId && ownerAccounts.has(person.hederaAccountId));
  });
  if (recipients.length === 0) return 0;

  await db.insert(notifications).values(
    recipients.map((i) => ({
      userId: i.userId,
      type: "price_drop" as const,
      payload: {
        gameId: game.id,
        slug: game.slug,
        title: game.title,
        fromUnits,
        priceUnits: toUnits,
        priceAsset: game.priceAsset,
        savedAtUnits: i.priceUnitsWhenAdded,
        percentOff: fromUnits > 0 ? Math.round(((fromUnits - toUnits) / fromUnits) * 100) : 0,
      },
    })),
  );

  for (const item of recipients) {
    const person = byId.get(item.userId);
    if (!person) continue;
    void emailPriceDrop({
      to: person.email,
      gameTitle: game.title,
      slug: game.slug,
      fromUnits,
      toUnits,
      asset: game.priceAsset,
      savedAtUnits: item.priceUnitsWhenAdded,
    });
  }

  logger.info({ gameId: game.id, notified: recipients.length }, "price drop notified");
  return recipients.length;
}

/**
 * Somebody's whole wishlist, with the thing a wishlist is for: what has changed
 * since they saved each game.
 */
export async function wishlistFor(userId: string) {
  const items = await db.query.wishlistItems.findMany({
    where: eq(wishlistItems.userId, userId),
    orderBy: desc(wishlistItems.createdAt),
  });
  if (items.length === 0) return [];

  const gameIds = items.map((i) => i.gameId);
  const [rows, agent] = await Promise.all([
    db.query.games.findMany({ where: inArray(games.id, gameIds), with: { studio: true } }),
    // One per person now, not one per game — see db/schema.ts#wishlistAgents.
    // Whether it is relevant to a given row is decided per item below, from
    // that row's own `agentMaxUnits`, not from a second table keyed by game.
    db.query.wishlistAgents.findFirst({ where: eq(wishlistAgents.buyerUserId, userId) }),
  ]);
  const byId = new Map(rows.map((g) => [g.id, g]));

  return items
    .filter((i) => byId.get(i.gameId)?.status !== "removed")
    .map((item) => {
      const game = byId.get(item.gameId)!;
      const savedAt = item.priceUnitsWhenAdded;
      const changeUnits = savedAt === null ? null : game.priceUnits - savedAt;

      return {
        addedAt: item.createdAt,
        notifyOnDrop: item.notifyOnDrop,
        game: {
          id: game.id,
          slug: game.slug,
          title: game.title,
          tagline: game.tagline,
          coverCid: game.coverCid,
          coverUrl: game.coverCid ? gatewayUrl(game.coverCid) : null,
          coverSeed: game.coverSeed,
          status: game.status,
          studio: { id: game.studio.id, name: game.studio.name, slug: game.studio.slug },
          priceUnits: game.priceUnits,
          priceAsset: game.priceAsset,
          priceUsd: toDisplayAmount(game.priceUnits, game.priceAsset),
          priceAssetDecimals: assetDecimals(game.priceAsset),
        },
        // The reason this list is worth opening. Null when the game predates
        // the price being captured at save time.
        savedAtUnits: savedAt,
        savedAtUsd: savedAt === null ? null : toDisplayAmount(savedAt, game.priceAsset),
        changeUnits,
        percentOff:
          savedAt && savedAt > 0 && changeUnits !== null && changeUnits < 0
            ? Math.round((-changeUnits / savedAt) * 100)
            : 0,
        // A game that stopped being for sale is still on the list, said out
        // loud rather than quietly dropped — someone who saved it deserves to
        // know what happened to it.
        stillForSale: game.status === "published",
        // The upgrade path. An agent turns "tell me" into "buy it for me": null
        // here means this row is a plain wishlist entry, not that no agent
        // exists — a person may have an agent and still leave some games as
        // plain wishlist rows on purpose.
        agentMaxUnits: item.agentMaxUnits,
        agentNote: item.agentNote,
        agent:
          agent && item.agentMaxUnits !== null
            ? { id: agent.id, status: agent.status, mode: agent.mode }
            : null,
      };
    });
}
