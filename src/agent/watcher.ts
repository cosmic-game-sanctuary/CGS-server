import { TopicMessageQuery, Timestamp } from "@hiero-ledger/sdk";
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  wishlistAgents,
  wishlistItems,
  agentDecisions,
  listenerState,
  notifications,
  users,
} from "../db/schema.js";
import client from "../services/hedera/client.js";
import { getAccountByEvmAddress } from "../services/hedera/mirror.js";
import { anchorAgentIdentity } from "../services/agent/identity.js";
import { agentBalance, retireAgent } from "../services/agent/wallet.js";
import { resolveHederaAccount } from "../services/users/repo.js";
import {
  eligibleWantsFor,
  wantsFor,
  planPurchases,
  needsJudgement,
  sanitizeVerdict,
  fallbackVerdict,
  roundIsDue,
  nextWire,
  atWire,
  type EligibleWant,
  type Verdict,
} from "../services/agent/decide.js";
import { rawVerdictSchema } from "../services/agent/model.js";
import { payForGame, payForVerdict } from "../services/x402/pay.js";
import { canAsk, decideByFor, ASK_WINDOW_MS } from "../services/agent/timing.js";
import { emailAgentPurchased, emailAgentExpired, emailAgentAsked } from "../services/email/messages.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.utils.js";

type Agent = typeof wishlistAgents.$inferSelect;
type Decision = typeof agentDecisions.$inferSelect;

/**
 * The wishlist agent, rebuilt for 1:N — one agent per person, several
 * wanted games, one shared budget.
 *
 * **What changed and why it had to.** The old watcher polled the Mirror Node
 * once per agent on a timer — 25 agents alone used a fifth of the public
 * node's entire rate budget, and 125 exhausted it, starving downloads and
 * ownership checks for everyone. This subscribes to the listings topic once,
 * for every agent at once, over gRPC — cost stays flat no matter how many
 * agents exist. `listener_state` existed for this resume cursor since Stage 5
 * and nothing read it until now.
 *
 * **What did not change.** This still reads the *public* topic through a real
 * subscription, never an internal "did a price change" flag — the one rule in
 * this whole project marked "do not get this wrong." The message only ever
 * tells this code *which game to look at*; the actual eligibility decision
 * re-reads that game's current price from the ordinary database, the same way
 * every other feature in this app treats `games.price_units` as ground truth.
 * Replaying an old message after a restart is therefore harmless — it just
 * asks "is this game still worth buying right now", and the honest answer
 * might be no.
 *
 * **Stage 19 adds the decision layer, and W9 moved when it runs.** A topic
 * message no longer means "buy". It means "look again, and work out when you
 * should decide". Most evaluations end by setting an alarm clock and spending
 * nothing: money only moves in a round where something is at its wire, an hour
 * before its sale ends, or where nothing eligible has a deadline to wait for.
 * See decide.ts#roundIsDue for why, and timing.ts#wireFor for the hour.
 *
 * At such a round, `planPurchases` clearing the whole eligible set is still
 * deterministic — no model call, no cost. Whenever it doesn't clear the set, a
 * real model call decides what to do with what's left: buy some now, decline
 * the rest, or — in ask-first mode, when there is genuinely time — ask first.
 * See services/agent/decide.ts for the rules the model's answer is checked
 * against before anything acts on it.
 */

let unsubscribe: (() => void) | null = null;

export async function startAgentListener(): Promise<void> {
  if (!env.HCS_LISTINGS_TOPIC) {
    logger.warn("no HCS_LISTINGS_TOPIC configured — the agent listener is not starting");
    return;
  }

  const cursor = await db.query.listenerState.findFirst({ where: eq(listenerState.id, 1) });
  // No prior cursor: start from now, not from the topic's beginning. Replaying
  // years of listings on a cold start would be harmless but slow and pointless
  // — nothing that old is still a live price for anything.
  const startTime = cursor?.lastConsensusAt ? Timestamp.fromDate(cursor.lastConsensusAt) : Timestamp.fromDate(new Date());

  if (!cursor) {
    await db
      .insert(listenerState)
      .values({ id: 1, topicId: env.HCS_LISTINGS_TOPIC, lastConsensusAt: null })
      .onConflictDoNothing();
  }

  const handle = new TopicMessageQuery({ topicId: env.HCS_LISTINGS_TOPIC, startTime }).subscribe(
    client,
    (_message, error) => {
      logger.error({ err: error }, "agent listener subscription error");
    },
    (message) => {
      const consensusAt = message.consensusTimestamp.toDate();
      let payload: { type?: string; gameId?: string; priceUnits?: number | null };
      try {
        payload = JSON.parse(Buffer.from(message.contents).toString("utf8"));
      } catch {
        payload = {};
      }

      // Fire-and-log: a subscription callback cannot be awaited, and one bad
      // message must not take the whole listener down.
      handleMessage(payload, consensusAt).catch((err) =>
        logger.error({ err, gameId: payload.gameId }, "handling a listings message failed"),
      );
    },
  );

  unsubscribe = () => handle.unsubscribe();
  logger.info({ topic: env.HCS_LISTINGS_TOPIC, resumedFrom: startTime.toDate().toISOString() }, "agent listener subscribed");
}

export function stopAgentListener(): void {
  unsubscribe?.();
  unsubscribe = null;
}

async function handleMessage(
  payload: { type?: string; gameId?: string; priceUnits?: number | null },
  consensusAt: Date,
): Promise<void> {
  // The cursor moves on every message, not only ones that trigger something —
  // otherwise a restart replays everything after the last message that
  // happened to matter, which grows without bound.
  await db.update(listenerState).set({ lastConsensusAt: consensusAt, updatedAt: new Date() }).where(eq(listenerState.id, 1));

  // Only messages that actually state a price are worth anyone's attention —
  // same filter the old watcher used, for the same reason: a delisting must
  // never look like an offer to something reading the topic.
  if (!payload.gameId || typeof payload.priceUnits !== "number") return;

  const wanters = await db.query.wishlistItems.findMany({
    where: and(eq(wishlistItems.gameId, payload.gameId), isNotNull(wishlistItems.agentMaxUnits)),
    columns: { userId: true },
  });
  if (wanters.length === 0) return;

  const buyerIds = [...new Set(wanters.map((w) => w.userId))];
  const agents = await db.query.wishlistAgents.findMany({
    where: and(inArray(wishlistAgents.buyerUserId, buyerIds), inArray(wishlistAgents.status, ["funded", "watching"])),
  });

  for (const agent of agents) {
    try {
      await evaluateAgent(agent);
    } catch (err) {
      logger.error({ err, agentId: agent.id }, "evaluating an agent failed");
    }
  }
}

/**
 * One agent's turn: work out what's eligible, claim the agent, decide what to
 * do with it, act, record it. Exported (not just called from `handleMessage`)
 * so the exact code path a real topic message triggers can also be driven
 * directly — the subscription mechanism that calls this is proven separately,
 * in isolation, rather than re-proven every time this logic is tested.
 */
export async function evaluateAgent(agent: Agent): Promise<void> {
  // The claim: exactly one caller can move a row from a resting state into
  // `buying`. Whoever loses this race — another message arriving in the same
  // instant, or the sweep firing this agent's scheduled round — gets zero rows
  // back and does nothing, the same conditional-UPDATE pattern Stage 17
  // verified under real concurrency. It is taken *first* now, before any Mirror
  // Node read, so the loser of a race spends nothing finding out it lost.
  const [claimed] = await db
    .update(wishlistAgents)
    .set({ status: "buying", claimedAt: new Date() })
    .where(and(eq(wishlistAgents.id, agent.id), inArray(wishlistAgents.status, ["funded", "watching"])))
    .returning();
  if (!claimed) return;

  try {
    await runRound(claimed);
  } finally {
    // Always released back to watching — bought, waiting, asked, declined, or
    // failed outright. A stuck `buying` row would silently stop this agent
    // from ever being evaluated again.
    await db.update(wishlistAgents).set({ status: "watching" }).where(eq(wishlistAgents.id, claimed.id));
  }
}

/**
 * One turn, with the agent already claimed by the caller.
 *
 * **Most turns end without spending anything, and that is the point.** A price
 * event no longer means "buy": it means "look again, and work out when you
 * should decide". Only a turn that finds something at its wire — or finds
 * nothing with a deadline to wait for at all — goes on to allocate money. See
 * decide.ts#roundIsDue.
 */
async function runRound(agent: Agent): Promise<void> {
  // Both halves. `pending` is never bought from — it is what tells the agent
  // that its money is spoken for, which is the difference between an
  // allocation and a reflex. See decide.ts#needsJudgement.
  const { eligible, pending } = await wantsFor(agent);

  // "A pending question expires if the world moves" (§4). Anything reaching
  // here means the eligible set may have changed since a question was written,
  // so it no longer describes a live decision.
  await supersedeAskedQuestions(agent.id);

  if (eligible.length === 0) {
    // Nothing is buyable any more, and the commonest way that happens is the
    // one thing waiting is genuinely exposed to: a studio ending a sale early.
    // A schedule that names only games nobody can buy is a countdown running
    // on the buyer's screen toward a deadline that stopped mattering.
    await scheduleNextRound(agent, []);
    return;
  }

  if (!roundIsDue(eligible)) {
    // The deferral, and the whole reason this agent is worth having. Something
    // it wants is cheap enough to buy right now and it is deliberately not
    // buying it, because a sale is open until it ends and more of the world
    // will be visible at the wire than is visible now.
    await scheduleNextRound(agent, eligible);
    return;
  }

  const balance = await agentBalance(agent);
  const deterministic = planPurchases(eligible, balance);
  if (deterministic.length === 0) {
    // It wants things and can afford none of them. Not a decision and not
    // worth a row every time a deadline passes, but the schedule still has to
    // move on, or a later wire never fires.
    await scheduleNextRound(agent, eligible);
    return;
  }

  // The agent pays; the GameKey belongs to whoever it is working for. Resolved
  // once per round rather than per purchase — it does not change mid-round,
  // and by the time an agent can buy at all it was already required to
  // resolve once, at anchoring (see runAgentSweep), so this is a cached read.
  const buyerUser = await db.query.users.findFirst({ where: eq(users.id, agent.buyerUserId) });
  const buyerAccountId = buyerUser ? await resolveHederaAccount(buyerUser) : null;
  if (!buyerAccountId) {
    logger.error({ agentId: agent.id }, "agent can't buy — its own buyer has no resolvable Hedera account");
    // Still reschedule. Returning bare would leave this agent with no alarm
    // clock at all, so it would never look again even once the buyer's account
    // exists — and a buyer who has never received anything is exactly the
    // person whose account is about to.
    await scheduleNextRound(agent, eligible);
    return;
  }

  const lastChance = atWire(eligible);
  const judged = needsJudgement(eligible, deterministic, pending, balance);
  const verdict = judged
    ? await getVerdict(agent, eligible, balance, deterministic)
    : fallbackVerdict(eligible, deterministic); // Nothing is being traded off: buy it, no model call, no cost.

  const bought = await actOnVerdict(agent, buyerAccountId, eligible, verdict);

  // One line per round, because until now the only thing an agent logged was a
  // completed purchase — and the interesting rounds are the ones where it
  // decides *not* to buy yet. Watching a deferral from outside the database is
  // otherwise impossible.
  logger.info(
    {
      agentId: agent.id,
      eligible: eligible.map((w) => w.title),
      lastChance: lastChance.map((w) => w.title),
      alsoWanted: pending.map((w) => w.title),
      balanceUnits: balance.toString(),
      askedModel: judged,
      thought: verdict.reasoning,
      buying: verdict.buyNow.map((w) => w.title),
      declining: verdict.decline.map((w) => w.title),
      // Titles, not ids, so this lines up against `buying` at a glance. The
      // two differ exactly when a settlement failed, which is the thing you
      // would be reading this line to find out.
      bought: eligible.filter((w) => bought.has(w.gameId)).map((w) => w.title),
    },
    judged ? "agent decided" : "agent bought without needing to think",
  );

  // What it bought is off the list; what is left may still have a wire ahead
  // of it, and something has to be holding that alarm clock.
  await scheduleNextRound(agent, eligible.filter((w) => !bought.has(w.gameId)));
}

/**
 * The alarm clock: one `held` row per agent, naming what it is choosing between
 * and when it will choose.
 *
 * **A schedule is not history**, which is why a superseded one is deleted
 * rather than resolved. "I planned to decide at four, then the plan changed"
 * is not something anyone wants a permanent row about, and a feed full of them
 * would bury the decisions that did happen. The row that survives is the live
 * one, and it is what the agent page renders as "It is waiting on purpose".
 *
 * Left untouched when nothing about it changed, so the countdown on screen does
 * not restart every time an unrelated price moves.
 */
async function scheduleNextRound(agent: Agent, remaining: EligibleWant[]): Promise<void> {
  const next = nextWire(remaining);
  const live = await db.query.agentDecisions.findFirst({
    where: and(
      eq(agentDecisions.agentId, agent.id),
      isNull(agentDecisions.resolvedAt),
      eq(agentDecisions.kind, "held"),
    ),
    orderBy: desc(agentDecisions.createdAt),
  });

  const ids = remaining.map((w) => w.gameId).sort();
  const unchanged =
    live !== undefined &&
    live.decideBy?.getTime() === next?.getTime() &&
    live.consideredGameIds.length === ids.length &&
    [...live.consideredGameIds].sort().every((id, i) => id === ids[i]);
  if (unchanged) return;

  if (live) {
    await db.delete(agentDecisions).where(eq(agentDecisions.id, live.id));
  }
  if (!next) return; // nothing left with a deadline: no alarm to set

  await db.insert(agentDecisions).values({
    agentId: agent.id,
    kind: "held",
    consideredGameIds: ids,
    chosenGameIds: ids,
    reasoning: null,
    decideBy: next,
  });
  logger.info(
    { agentId: agent.id, decidesAt: next.toISOString(), choosingBetween: remaining.map((w) => w.title) },
    "agent is waiting for the wire",
  );
}

async function supersedeAskedQuestions(agentId: string): Promise<void> {
  const superseded = await db
    .update(agentDecisions)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(agentDecisions.agentId, agentId),
        isNull(agentDecisions.resolvedAt),
        eq(agentDecisions.kind, "asked"),
      ),
    )
    .returning({ id: agentDecisions.id });
  if (superseded.length > 0) {
    logger.info({ agentId, superseded: superseded.map((s) => s.id) }, "a new price event superseded a pending agent question");
  }
}

/** Only ever called when something eligible was left over — Shape C or D. */
async function getVerdict(
  agent: Agent,
  eligible: EligibleWant[],
  balance: bigint,
  deterministic: EligibleWant[],
): Promise<Verdict> {
  // Checked here rather than only inside the route, so a deployment with no
  // model configured never *pays* for a verdict it cannot be given. The
  // deterministic plan is a real answer, not an error state.
  if (!env.GROQ_API_KEY) return fallbackVerdict(eligible, deterministic);

  try {
    const paid = await payForVerdict({
      walletId: agent.agentWalletId,
      accountId: agent.agentAccountId!,
      publicKeyHex: agent.agentPublicKeyHex,
    });
    const raw = rawVerdictSchema.parse(paid.verdict);
    return sanitizeVerdict(raw, eligible, balance, deterministic, paid.costUnits);
  } catch (err) {
    // Times out, errs, or the facilitator/route rejects it — rule 7: degrade
    // to the deterministic plan, never to stuck. The agent still does
    // something real with what it can afford this round.
    logger.error({ err, agentId: agent.id }, "agent verdict call failed — falling back to the deterministic plan");
    return fallbackVerdict(eligible, deterministic);
  }
}

function tightestDeadline(wants: EligibleWant[]): Date | null {
  return wants.reduce<Date | null>((soonest, w) => {
    if (!w.promotionEndsAt) return soonest;
    if (!soonest || w.promotionEndsAt < soonest) return w.promotionEndsAt;
    return soonest;
  }, null);
}

/** Returns the game ids money actually moved for, so the caller can drop them
 *  from the schedule it sets next. */
async function actOnVerdict(
  agent: Agent,
  buyerAccountId: string,
  eligible: EligibleWant[],
  verdict: Verdict,
): Promise<Set<string>> {
  const consideredIds = eligible.map((w) => w.gameId);
  // The model call this round cost at most one charge — attributed to
  // whichever row is written first, never repeated across several rows from
  // the same round. `null` throughout means no model was called at all.
  let costLeft = verdict.costUnits;
  const takeCost = () => {
    const cost = costLeft;
    costLeft = null;
    return cost;
  };

  if (agent.mode === "ask_first" && verdict.askFirst && verdict.buyNow.length > 0) {
    const deadline = tightestDeadline(verdict.buyNow);
    if (canAsk(deadline)) {
      const decideBy = deadline ? decideByFor(deadline, 0) : new Date(Date.now() + ASK_WINDOW_MS);
      const [row] = await db
        .insert(agentDecisions)
        .values({
          agentId: agent.id,
          kind: "asked",
          consideredGameIds: consideredIds,
          chosenGameIds: verdict.buyNow.map((w) => w.gameId),
          reasoning: verdict.reasoning,
          inferenceCostUnits: takeCost(),
          decideBy,
        })
        .returning();
      await notifyAsked(agent, row!, verdict.buyNow, decideBy);
      // Declines are a separate decision from the same round — they proceed
      // regardless of whether buyNow got escalated to a question.
      await recordDeclines(agent, consideredIds, verdict.decline, verdict.reasoning, takeCost);
      return new Set();
    }
    // "If it doesn't fit, don't ask — decide." Falls through to buy now. At a
    // wire this is always the branch taken: `canAsk` needs 19 hours of runway
    // and the wire is by definition one hour out, so an ask-first agent still
    // decides for itself at the moment it matters rather than posting a
    // question nobody can answer in time.
  }

  const bought =
    verdict.buyNow.length > 0
      ? await executeBuys(agent, buyerAccountId, consideredIds, verdict.buyNow, verdict.reasoning, takeCost())
      : new Set<string>();
  await recordDeclines(agent, consideredIds, verdict.decline, verdict.reasoning, takeCost);
  return bought;
}

async function recordDeclines(
  agent: Agent,
  consideredIds: string[],
  decline: EligibleWant[],
  reasoning: string | null,
  takeCost: () => number | null,
): Promise<void> {
  if (decline.length === 0) return;
  await db.insert(agentDecisions).values({
    agentId: agent.id,
    kind: "declined",
    consideredGameIds: consideredIds,
    chosenGameIds: decline.map((w) => w.gameId),
    reasoning,
    inferenceCostUnits: takeCost(),
    resolvedAt: new Date(),
  });
}

async function notifyAsked(
  agent: Agent,
  decision: Decision,
  buyNow: EligibleWant[],
  decideBy: Date,
): Promise<void> {
  await db.insert(notifications).values({
    userId: agent.buyerUserId,
    type: "agent_asked",
    payload: {
      agentId: agent.id,
      decisionId: decision.id,
      reasoning: decision.reasoning,
      decideBy,
      candidates: buyNow.map((w) => ({ gameId: w.gameId, slug: w.slug, title: w.title, priceUnits: w.currentPriceUnits, priceAsset: w.asset })),
    },
  });

  const buyer = await db.query.users.findFirst({ where: eq(users.id, agent.buyerUserId) });
  if (buyer) {
    void emailAgentAsked({
      to: buyer.email,
      decisionId: decision.id,
      reasoning: decision.reasoning ?? "",
      candidates: buyNow.map((w) => ({ gameTitle: w.title, priceUnits: w.currentPriceUnits, asset: w.asset })),
      deadline: decideBy,
      onTimeout: agent.onTimeout,
    }).catch((err) => logger.error({ err, agentId: agent.id }, "emailing an ask failed"));
  }
}

/**
 * Executes a set of buys and — only if at least one actually settled — writes
 * the audit row and notifies once for the whole round, never once per game
 * (an agent clearing six wants at once is one email, not six).
 */
async function executeBuys(
  agent: Agent,
  buyerAccountId: string,
  consideredIds: string[],
  buyNow: EligibleWant[],
  reasoning: string | null,
  costUnits: number | null,
): Promise<Set<string>> {
  const bought: EligibleWant[] = [];
  for (const want of buyNow) {
    try {
      await payForGame(
        want.gameId,
        { walletId: agent.agentWalletId, accountId: agent.agentAccountId!, publicKeyHex: agent.agentPublicKeyHex },
        buyerAccountId,
      );
      bought.push(want);
    } catch (err) {
      // One failed purchase does not stop the others — each was planned
      // against a balance that did not move, so they are still real.
      logger.error({ err, agentId: agent.id, gameId: want.gameId }, "agent purchase failed");
    }
  }
  if (bought.length === 0) return new Set();

  await db.insert(agentDecisions).values({
    agentId: agent.id,
    kind: "bought",
    consideredGameIds: consideredIds,
    chosenGameIds: bought.map((w) => w.gameId),
    reasoning,
    inferenceCostUnits: costUnits,
    resolvedAt: new Date(),
  });

  const buyer = await db.query.users.findFirst({ where: eq(users.id, agent.buyerUserId) });
  await db.insert(notifications).values({
    userId: agent.buyerUserId,
    type: "agent_purchased",
    payload: {
      agentId: agent.id,
      purchases: bought.map((w) => ({ gameId: w.gameId, slug: w.slug, title: w.title, priceUnits: w.currentPriceUnits, priceAsset: w.asset })),
    },
  });

  if (buyer) {
    void emailAgentPurchased({
      to: buyer.email,
      purchases: bought.map((w) => ({ gameTitle: w.title, priceUnits: w.currentPriceUnits, asset: w.asset })),
    }).catch((err) => logger.error({ err, agentId: agent.id }, "emailing a purchase failed"));
  }

  logger.info({ agentId: agent.id, bought: bought.map((w) => w.gameId) }, "agent bought");
  return new Set(bought.map((w) => w.gameId));
}

/**
 * A human answering an `asked` decision, or clearing a want it named. Claims
 * both the agent and the specific decision row before doing anything, so this
 * can never race the sweep resolving the same overdue question at the same
 * moment — same conditional-UPDATE pattern as everywhere else in this file.
 * The route (agent.routes.ts) has already confirmed `decision` belongs to
 * `agent` and is still kind `"asked"`; this only handles the claim and the
 * outcome.
 */
export async function respondToDecision(
  agent: Agent,
  decision: Decision,
  action: "buy" | "skip" | "remove" | "keep",
): Promise<{ outcome: "bought" | "declined"; alreadyResolved: boolean }> {
  const [claimed] = await db
    .update(wishlistAgents)
    .set({ status: "buying", claimedAt: new Date() })
    .where(and(eq(wishlistAgents.id, agent.id), inArray(wishlistAgents.status, ["funded", "watching"])))
    .returning();
  if (!claimed) return { outcome: "declined", alreadyResolved: false };

  try {
    const [claimedDecision] = await db
      .update(agentDecisions)
      .set({ resolvedAt: new Date() })
      .where(and(eq(agentDecisions.id, decision.id), isNull(agentDecisions.resolvedAt)))
      .returning();
    if (!claimedDecision) return { outcome: "declined", alreadyResolved: true };

    if (action === "remove") {
      await db
        .update(wishlistItems)
        .set({ agentMaxUnits: null, agentNote: null })
        .where(and(eq(wishlistItems.userId, agent.buyerUserId), inArray(wishlistItems.gameId, decision.chosenGameIds)));
    }

    if (action !== "buy") {
      await db.insert(agentDecisions).values({
        agentId: agent.id,
        kind: "declined",
        consideredGameIds: decision.consideredGameIds,
        chosenGameIds: decision.chosenGameIds,
        reasoning: `Answered by the buyer: ${action}.`,
        resolvedAt: new Date(),
      });
      return { outcome: "declined", alreadyResolved: false };
    }

    const eligible = await eligibleWantsFor(claimed);
    const stillWanted = eligible.filter((w) => decision.chosenGameIds.includes(w.gameId));
    const balance = await agentBalance(claimed);
    const toBuy = planPurchases(stillWanted, balance);

    const buyerUser = await db.query.users.findFirst({ where: eq(users.id, agent.buyerUserId) });
    const buyerAccountId = buyerUser ? await resolveHederaAccount(buyerUser) : null;

    if (toBuy.length === 0 || !buyerAccountId) {
      await db.insert(agentDecisions).values({
        agentId: agent.id,
        kind: "declined",
        consideredGameIds: decision.consideredGameIds,
        chosenGameIds: decision.chosenGameIds,
        reasoning: "Answered buy, but nothing named was still eligible and affordable by the time it settled.",
        resolvedAt: new Date(),
      });
      return { outcome: "declined", alreadyResolved: false };
    }

    await executeBuys(claimed, buyerAccountId, decision.consideredGameIds, toBuy, null, null);
    return { outcome: "bought", alreadyResolved: false };
  } finally {
    await db.update(wishlistAgents).set({ status: "watching" }).where(eq(wishlistAgents.id, claimed.id));
  }
}

/**
 * A scheduled round whose wire arrived, or an ask-first question whose
 * `decideBy` passed with nobody answering it. Re-checked fresh rather than
 * replayed from the original round — "budget is never reserved," and neither
 * is eligibility.
 */
async function resolveOverduePending(): Promise<number> {
  const overdue = await db.query.agentDecisions.findMany({
    where: and(isNull(agentDecisions.resolvedAt), isNotNull(agentDecisions.decideBy), lte(agentDecisions.decideBy, new Date())),
  });

  let resolved = 0;
  for (const decision of overdue) {
    try {
      await resolveDecision(decision);
      resolved += 1;
    } catch (err) {
      logger.error({ err, decisionId: decision.id }, "resolving an overdue agent decision failed");
    }
  }
  return resolved;
}

async function resolveDecision(decision: Decision): Promise<void> {
  const agent = await db.query.wishlistAgents.findFirst({ where: eq(wishlistAgents.id, decision.agentId) });
  if (!agent) return;

  const [claimed] = await db
    .update(wishlistAgents)
    .set({ status: "buying", claimedAt: new Date() })
    .where(and(eq(wishlistAgents.id, agent.id), inArray(wishlistAgents.status, ["funded", "watching"])))
    .returning();
  if (!claimed) return; // mid-evaluation elsewhere right now — the next sweep tick will retry

  try {
    // **The wire has arrived.** A `held` row is this agent's alarm clock, not a
    // stored decision, so nothing in it is replayed: the round is run again
    // from scratch against prices, balance and ownership as they are *now*.
    // That matters because everything the wait was for happened in between —
    // another sale may have started, the buyer may have added a want, the
    // wallet may have less in it. Deleted rather than resolved, for the reason
    // in scheduleNextRound: a schedule is not history.
    if (decision.kind === "held") {
      const consumed = await db
        .delete(agentDecisions)
        .where(and(eq(agentDecisions.id, decision.id), isNull(agentDecisions.resolvedAt)))
        .returning({ id: agentDecisions.id });
      if (consumed.length === 0) return; // an earlier tick got there first
      await runRound(claimed);
      return;
    }

    const [claimedDecision] = await db
      .update(agentDecisions)
      .set({ resolvedAt: new Date() })
      .where(and(eq(agentDecisions.id, decision.id), isNull(agentDecisions.resolvedAt)))
      .returning();
    if (!claimedDecision) return; // a person, or an earlier tick, already resolved this

    // `onTimeout` governs an unanswered question (§4's ask-first clock), and
    // by here that is the only kind of row left.
    const timedOutToSkip = agent.onTimeout === "skip";

    let bought: EligibleWant[] = [];
    if (!timedOutToSkip) {
      const eligible = await eligibleWantsFor(claimed);
      const stillWanted = eligible.filter((w) => decision.chosenGameIds.includes(w.gameId));
      const balance = await agentBalance(claimed);
      bought = planPurchases(stillWanted, balance);

      if (bought.length > 0) {
        const buyerUser = await db.query.users.findFirst({ where: eq(users.id, agent.buyerUserId) });
        const buyerAccountId = buyerUser ? await resolveHederaAccount(buyerUser) : null;
        if (buyerAccountId) {
          await executeBuys(claimed, buyerAccountId, decision.chosenGameIds, bought, null, null);
        } else {
          bought = [];
        }
      }
    }

    if (bought.length === 0) {
      await db.insert(agentDecisions).values({
        agentId: agent.id,
        kind: "declined",
        consideredGameIds: decision.chosenGameIds,
        chosenGameIds: decision.chosenGameIds,
        reasoning: timedOutToSkip
          ? "An ask-first question went unanswered past its deadline; onTimeout is skip."
          : "No longer eligible or affordable by the time this deadline arrived.",
        resolvedAt: new Date(),
      });
    }
  } finally {
    await db.update(wishlistAgents).set({ status: "watching" }).where(eq(wishlistAgents.id, claimed.id));
  }
}

/**
 * Three things a subscription cannot do on its own: anchor identity the first
 * time a wallet resolves, end agents whose expiry has passed, and fire a round
 * whose scheduled moment has come. The third is what makes deciding at the
 * wire possible at all — nothing on a public topic announces "an hour from
 * now", so the clock has to be ours. All three are cheap, low-frequency checks
 * against indexed columns — this runs on a slow timer
 * (index.ts), not per message, and touches nothing that scales with agent
 * count the way the old per-agent poll did.
 */
export async function runAgentSweep(): Promise<{
  anchored: number;
  expired: number;
  resolved: number;
  reclaimed: number;
}> {
  // A claim with no lease. `evaluateAgent`/`respondToDecision`/`resolveDecision`
  // all release `buying` back to `watching` in a `finally`, which covers every
  // in-process failure — but not the process itself dying mid-round (killed,
  // crashed, redeployed). Nothing else ever claims from `buying`, so a row
  // stranded there stops being evaluated forever: no error, no log line, just
  // silence. Reclaimed here rather than trusted to self-heal, and done before
  // anything else this tick so a reclaimed agent is eligible for the rest of
  // this same sweep. Real rounds finish in seconds; `AGENT_STALE_CLAIM_MS`
  // (default 5 minutes) is headroom, not a target.
  const staleBefore = new Date(Date.now() - env.AGENT_STALE_CLAIM_MS);
  const reclaimedRows = await db
    .update(wishlistAgents)
    .set({ status: "watching" })
    .where(
      and(
        eq(wishlistAgents.status, "buying"),
        isNotNull(wishlistAgents.claimedAt),
        lt(wishlistAgents.claimedAt, staleBefore),
      ),
    )
    .returning({ id: wishlistAgents.id, claimedAt: wishlistAgents.claimedAt });
  for (const row of reclaimedRows) {
    logger.error(
      { agentId: row.id, claimedAt: row.claimedAt?.toISOString() },
      "reclaimed an agent stranded in buying — its round's process likely died mid-round",
    );
  }
  const reclaimed = reclaimedRows.length;

  let anchored = 0;
  const drafts = await db.query.wishlistAgents.findMany({ where: eq(wishlistAgents.status, "draft") });
  for (const agent of drafts) {
    const account = await getAccountByEvmAddress(agent.agentEvmAddress);
    if (!account) continue; // not funded yet — a normal, common wait, not an error

    // The anchor's whole point is naming who is really behind this wallet, so
    // it needs the buyer's own Hedera account, not the agent's — a buyer who
    // has never received anything themselves has nothing to name yet, so
    // anchoring waits one more round rather than anchoring the wrong party.
    const buyer = await db.query.users.findFirst({ where: eq(users.id, agent.buyerUserId) });
    const buyerAccountId = buyer ? await resolveHederaAccount(buyer) : null;
    if (!buyerAccountId) continue;

    const { aid } = await anchorAgentIdentity(agent.id, account.account, buyerAccountId);
    await db
      .update(wishlistAgents)
      .set({ status: "funded", agentAccountId: account.account, hcs14Aid: aid })
      .where(eq(wishlistAgents.id, agent.id));
    anchored += 1;
  }

  let expired = 0;
  const due = await db.query.wishlistAgents.findMany({
    where: and(
      inArray(wishlistAgents.status, ["funded", "watching"]),
      isNotNull(wishlistAgents.expiresAt),
      lt(wishlistAgents.expiresAt, new Date()),
    ),
  });
  for (const agent of due) {
    const { refundedUnits } = await retireAgent(agent, "expired");
    const buyer = await db.query.users.findFirst({ where: eq(users.id, agent.buyerUserId) });
    await db.insert(notifications).values({
      userId: agent.buyerUserId,
      type: "agent_expired",
      payload: { agentId: agent.id, refundedUnits: refundedUnits.toString() },
    });
    if (buyer && refundedUnits > 0n) {
      void emailAgentExpired({ to: buyer.email, returnedUnits: Number(refundedUnits), asset: env.X402_ASSET }).catch(
        (err) => logger.error({ err, agentId: agent.id }, "emailing an expiry failed"),
      );
    }
    expired += 1;
  }

  const resolved = await resolveOverduePending();

  return { anchored, expired, resolved, reclaimed };
}
