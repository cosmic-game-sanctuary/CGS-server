import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { wishlistItems, games, users, wishlistAgents } from "../../db/schema.js";
import { hasEntitlement } from "../games/entitlement.js";
import { activePromotionFor } from "../games/promotions.js";

type Agent = typeof wishlistAgents.$inferSelect;

/**
 * Eligibility and allocation — the part of the agent that runs with no model
 * at all.
 *
 * This is deliberately the whole decision for Stage 18. Stage 19 adds a model
 * only for genuine contention (more affordable than the balance covers); this
 * file's greedy allocation is also *that* stage's fallback when the model
 * times out, errs, or is skipped — see wishlist-agent-spec.md §4, rule 7:
 * "degrade to working, never to stuck."
 */

export type EligibleWant = {
  wishlistItemId: string;
  gameId: string;
  slug: string;
  title: string;
  agentMaxUnits: number;
  currentPriceUnits: number;
  asset: string;
  /** From an active promotion on this game, if there is one. */
  promotionEndsAt: Date | null;
};

/**
 * Every want belonging to this agent's buyer that is affordable *right now*,
 * still published, and not already owned.
 *
 * Ownership is checked with `hasEntitlement`, not the Mirror Node alone — the
 * same reasoning as everywhere else it's used: the gap between a settlement
 * and a mint landing is real, and re-buying something already paid for in that
 * gap would be a second charge for the same game.
 */
export async function eligibleWantsFor(agent: Agent): Promise<EligibleWant[]> {
  const buyer = await db.query.users.findFirst({ where: eq(users.id, agent.buyerUserId) });
  if (!buyer) return [];

  const wants = await db.query.wishlistItems.findMany({
    where: and(eq(wishlistItems.userId, agent.buyerUserId), isNotNull(wishlistItems.agentMaxUnits)),
  });
  if (wants.length === 0) return [];

  const gameRows = await db.query.games.findMany({
    where: inArray(games.id, wants.map((w) => w.gameId)),
  });
  const gameById = new Map(gameRows.map((g) => [g.id, g]));

  const out: EligibleWant[] = [];
  for (const want of wants) {
    const game = gameById.get(want.gameId);
    if (!game || game.status !== "published") continue;
    if (game.priceUnits > want.agentMaxUnits!) continue; // not affordable yet

    const owned = await hasEntitlement(buyer.evmAddress, game);
    if (owned.owned) continue; // drop silently — rule 6, nothing to tell anyone

    const promo = await activePromotionFor(game.id);
    out.push({
      wishlistItemId: want.id,
      gameId: game.id,
      slug: game.slug,
      title: game.title,
      agentMaxUnits: want.agentMaxUnits!,
      currentPriceUnits: game.priceUnits,
      asset: game.priceAsset,
      promotionEndsAt: promo?.endsAt ?? null,
    });
  }
  return out;
}

/**
 * Which of the eligible wants to actually buy, given what the wallet holds.
 *
 * The ordering is the doc's own strongest heuristic: whatever expires soonest
 * goes first, because a sale with no deadline can be reconsidered next round
 * and one that is about to end cannot. Ties (including "no deadline at all")
 * break on price, cheapest first, which is what lets the greedy walk actually
 * maximise how many wants get satisfied rather than spending everything on
 * one.
 *
 * This is real Shape A ("one, it fits") and Shape B ("several, all fit")
 * whenever the budget allows, and it is the honest fallback for Shape C
 * (contention) until a model exists to do better — buying *something* real
 * beats waiting on a judgment call that has not been built yet.
 */
export function planPurchases(eligible: EligibleWant[], balanceUnits: bigint): EligibleWant[] {
  const sorted = [...eligible].sort((a, b) => {
    if (a.promotionEndsAt && b.promotionEndsAt) {
      return a.promotionEndsAt.getTime() - b.promotionEndsAt.getTime();
    }
    if (a.promotionEndsAt) return -1;
    if (b.promotionEndsAt) return 1;
    return a.currentPriceUnits - b.currentPriceUnits;
  });

  const chosen: EligibleWant[] = [];
  let remaining = balanceUnits;
  for (const want of sorted) {
    const cost = BigInt(want.currentPriceUnits);
    if (cost <= remaining) {
      chosen.push(want);
      remaining -= cost;
    }
  }
  return chosen;
}
