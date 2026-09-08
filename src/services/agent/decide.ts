import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { wishlistItems, games, users, wishlistAgents } from "../../db/schema.js";
import { hasEntitlement } from "../games/entitlement.js";
import { activePromotionFor } from "../games/promotions.js";
import { priceHistory } from "../games/listing.js";

type Agent = typeof wishlistAgents.$inferSelect;

/**
 * Eligibility, allocation, and — since Stage 19 — the shape a model verdict is
 * validated against before anything acts on it.
 *
 * Stages A and B (one thing fits; several things fit together) are still
 * decided here with no model call at all: `planPurchases` clearing every
 * eligible want *is* the decision. A model is only ever consulted when it
 * doesn't — something eligible was left unbought — which is Shape C
 * (contention) and Shape D (a deliberate hold) from wishlist-agent-spec.md §4.
 * `planPurchases`'s output remains the fallback for both: if the model times
 * out, errs, or returns something that doesn't survive `sanitizeVerdict`,
 * rule 7 applies — "degrade to working, never to stuck."
 */

export type EligibleWant = {
  wishlistItemId: string;
  gameId: string;
  slug: string;
  title: string;
  agentMaxUnits: number;
  currentPriceUnits: number;
  asset: string;
  /** In the buyer's own words, or null if they left it blank. */
  note: string | null;
  /** The cheapest this game has ever been, current price included. */
  lowestEverUnits: number;
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
    const history = await priceHistory(game);
    out.push({
      wishlistItemId: want.id,
      gameId: game.id,
      slug: game.slug,
      title: game.title,
      agentMaxUnits: want.agentMaxUnits!,
      currentPriceUnits: game.priceUnits,
      asset: game.priceAsset,
      note: want.agentNote,
      lowestEverUnits: history.reduce((low, h) => Math.min(low, h.toUnits), game.priceUnits),
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

/**
 * True when the deterministic pass didn't clear the whole eligible set — the
 * only condition under which Stage 19 spends anything on thinking. An agent
 * with nothing left over after `planPurchases` is Shape A or B and this is
 * `false`; nothing calls the model.
 */
export function needsJudgement(eligible: EligibleWant[], deterministic: EligibleWant[]): boolean {
  return deterministic.length < eligible.length;
}

/** What the model is asked to return. Kept flat so a strict JSON schema can
 * describe it exactly — see services/agent/model.ts. */
export type RawVerdict = {
  buyNow: string[];
  hold: { gameId: string; holdHours: number }[];
  decline: string[];
  askFirst: boolean;
  reasoning: string;
};

export type Verdict = {
  buyNow: EligibleWant[];
  hold: { want: EligibleWant; holdHours: number }[];
  decline: EligibleWant[];
  askFirst: boolean;
  reasoning: string | null;
  /** null for the deterministic fallback — nothing was actually inferred. */
  costUnits: number | null;
};

/**
 * Rules enforced in code, not trusted from the prompt (§4's numbered list).
 * A model's `buyNow` is honoured only if every id is genuinely eligible and
 * the total genuinely fits the balance; otherwise the whole verdict is
 * discarded in favour of the deterministic plan, per rule 7. A game named in
 * more than one list is resolved buy > hold > decline, so the worst that
 * happens is it gets bought — never silently dropped, never bought twice.
 */
export function sanitizeVerdict(
  raw: RawVerdict,
  eligible: EligibleWant[],
  balanceUnits: bigint,
  deterministic: EligibleWant[],
  costUnits: number,
): Verdict {
  const byId = new Map(eligible.map((w) => [w.gameId, w]));
  const fellBack = () => fallbackVerdict(eligible, deterministic);

  const buyNow = raw.buyNow.map((id) => byId.get(id)).filter((w): w is EligibleWant => !!w);
  const totalCost = buyNow.reduce((sum, w) => sum + BigInt(w.currentPriceUnits), 0n);
  if (buyNow.length !== raw.buyNow.length || totalCost > balanceUnits) return fellBack();

  const claimed = new Set(buyNow.map((w) => w.gameId));
  const hold = raw.hold
    .filter((h) => !claimed.has(h.gameId))
    .map((h) => ({ want: byId.get(h.gameId), holdHours: h.holdHours }))
    .filter((h): h is { want: EligibleWant; holdHours: number } => !!h.want)
    .map((h) => {
      claimed.add(h.want.gameId);
      return h;
    });

  const decline = raw.decline
    .map((id) => byId.get(id))
    .filter((w): w is EligibleWant => !!w && !claimed.has(w.gameId));

  return { buyNow, hold, decline, askFirst: raw.askFirst, reasoning: raw.reasoning, costUnits };
}

/** No model call happened, or its answer didn't survive `sanitizeVerdict` —
 * buy whatever the greedy allocation already decided, explain nothing,
 * charge nothing. This is rule 7's floor. */
export function fallbackVerdict(eligible: EligibleWant[], deterministic: EligibleWant[]): Verdict {
  const chosenIds = new Set(deterministic.map((w) => w.gameId));
  return {
    buyNow: deterministic,
    hold: [],
    decline: eligible.filter((w) => !chosenIds.has(w.gameId)),
    askFirst: false,
    reasoning: null,
    costUnits: null,
  };
}
