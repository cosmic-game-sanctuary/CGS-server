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
 * A want the buyer has that is **not** affordable yet.
 *
 * These are the whole reason the agent has anything to think about. A budget
 * only feels scarce next to what else it is wanted for, and an agent that can
 * see nothing but what is on sale this second cannot know that spending now
 * costs it something later. It just buys the first cheap thing and runs out.
 */
export type PendingWant = {
  gameId: string;
  title: string;
  agentMaxUnits: number;
  currentPriceUnits: number;
  asset: string;
  note: string | null;
  lowestEverUnits: number;
  promotionEndsAt: Date | null;
};

/**
 * Everything this buyer wants, split by whether it can be had right now.
 *
 * Ownership is checked with `hasEntitlement`, not the Mirror Node alone — the
 * same reasoning as everywhere else it's used: the gap between a settlement
 * and a mint landing is real, and re-buying something already paid for in that
 * gap would be a second charge for the same game.
 */
export async function wantsFor(
  agent: Agent,
): Promise<{ eligible: EligibleWant[]; pending: PendingWant[] }> {
  const buyer = await db.query.users.findFirst({ where: eq(users.id, agent.buyerUserId) });
  if (!buyer) return { eligible: [], pending: [] };

  const wants = await db.query.wishlistItems.findMany({
    where: and(eq(wishlistItems.userId, agent.buyerUserId), isNotNull(wishlistItems.agentMaxUnits)),
  });
  if (wants.length === 0) return { eligible: [], pending: [] };

  const gameRows = await db.query.games.findMany({
    where: inArray(games.id, wants.map((w) => w.gameId)),
  });
  const gameById = new Map(gameRows.map((g) => [g.id, g]));

  const eligible: EligibleWant[] = [];
  const pending: PendingWant[] = [];

  for (const want of wants) {
    const game = gameById.get(want.gameId);
    if (!game || game.status !== "published") continue;

    const owned = await hasEntitlement(buyer.evmAddress, game);
    if (owned.owned) continue; // drop silently — rule 6, nothing to tell anyone

    const promo = await activePromotionFor(game.id);
    const history = await priceHistory(game);
    const common = {
      gameId: game.id,
      title: game.title,
      agentMaxUnits: want.agentMaxUnits!,
      currentPriceUnits: game.priceUnits,
      asset: game.priceAsset,
      note: want.agentNote,
      lowestEverUnits: history.reduce((low, h) => Math.min(low, h.toUnits), game.priceUnits),
      promotionEndsAt: promo?.endsAt ?? null,
    };

    if (game.priceUnits > want.agentMaxUnits!) {
      pending.push(common);
      continue;
    }
    eligible.push({ ...common, wishlistItemId: want.id, slug: game.slug });
  }

  return { eligible, pending };
}

/**
 * Every want that is affordable *right now*. The half of `wantsFor` that
 * existing callers want, kept as its own name because "what can I buy" is a
 * different question from "what does this person want".
 */
export async function eligibleWantsFor(agent: Agent): Promise<EligibleWant[]> {
  return (await wantsFor(agent)).eligible;
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
 * Is there actually a decision here, or just an obvious purchase?
 *
 * This used to ask only whether the greedy plan left something eligible
 * unbought, and that turned out to be the wrong question in the case the agent
 * exists for. Two games, both wanted at $1, a $1.20 budget: they almost never
 * go on sale in the same instant. The first one to drop is the only thing
 * eligible, the greedy plan clears it, nothing looks contested, and the agent
 * spends the budget on whichever sale happened to start first. The second game
 * then never becomes affordable. **No decision was ever made** — the outcome
 * was decided by the order two studios happened to press a button.
 *
 * So the real question is not "is something left over now" but **"does buying
 * this cost me something I also want"**. Money the buyer has earmarked for
 * other wants is not spare, even when nothing else is on sale this second.
 *
 * When that is true, the choice is genuinely open: buy now, or wait. Waiting
 * is close to free, because a sale is still there until it ends — so the agent
 * can hold and decide at the last responsible moment, with more of the world
 * visible than it has right now. That is the judgement worth paying for.
 */
export function needsJudgement(
  eligible: EligibleWant[],
  deterministic: EligibleWant[],
  pending: PendingWant[] = [],
  balanceUnits = 0n,
): boolean {
  // Something eligible was left unbought: contention in the plainest sense.
  if (deterministic.length < eligible.length) return true;
  if (deterministic.length === 0) return false;

  // Nothing left over, but is the money spoken for? A want the buyer cannot
  // afford yet is still a claim on this balance, and spending down past it
  // forecloses that claim without anyone deciding to.
  const spend = deterministic.reduce((sum, w) => sum + BigInt(w.currentPriceUnits), 0n);
  const left = balanceUnits - spend;
  return pending.some((w) => BigInt(w.agentMaxUnits) > left);
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
