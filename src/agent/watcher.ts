import { TopicMessageQuery, Timestamp } from "@hiero-ledger/sdk";
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
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
import { eligibleWantsFor, planPurchases, type EligibleWant } from "../services/agent/decide.js";
import { payForGame } from "../services/x402/pay.js";
import { emailAgentPurchased, emailAgentExpired } from "../services/email/messages.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.utils.js";

type Agent = typeof wishlistAgents.$inferSelect;

/**
 * The wishlist agent, rewritten for 1:N — one agent per person, several
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
 * One agent's turn: work out what it can afford, claim it, buy it, record it.
 * Exported (not just called from `handleMessage`) so the exact code path a
 * real topic message triggers can also be driven directly — the subscription
 * mechanism that calls this is proven separately, in isolation, rather than
 * re-proven every time this logic is tested.
 */
export async function evaluateAgent(agent: Agent): Promise<void> {
  const eligible = await eligibleWantsFor(agent);
  if (eligible.length === 0) return;

  const balance = await agentBalance(agent);
  const chosen = planPurchases(eligible, balance);
  if (chosen.length === 0) return; // eligible but nothing fits the balance yet

  // The agent pays; the GameKey belongs to whoever it is working for. Resolved
  // once per round rather than per purchase — it does not change mid-round,
  // and by the time an agent can buy at all it was already required to
  // resolve once, at anchoring (see runAgentSweep), so this is a cached read.
  const buyerUser = await db.query.users.findFirst({ where: eq(users.id, agent.buyerUserId) });
  const buyerAccountId = buyerUser ? await resolveHederaAccount(buyerUser) : null;
  if (!buyerAccountId) {
    logger.error({ agentId: agent.id }, "agent can't buy — its own buyer has no resolvable Hedera account");
    return;
  }

  // The claim: exactly one caller can move a row from a resting state into
  // `buying`. Whoever loses this race — another message arriving in the same
  // instant — gets zero rows back and does nothing, the same conditional-
  // UPDATE pattern Stage 17 verified under real concurrency.
  const [claimed] = await db
    .update(wishlistAgents)
    .set({ status: "buying" })
    .where(and(eq(wishlistAgents.id, agent.id), inArray(wishlistAgents.status, ["funded", "watching"])))
    .returning();
  if (!claimed) return;

  const bought: EligibleWant[] = [];
  try {
    for (const want of chosen) {
      try {
        await payForGame(
          want.gameId,
          {
            walletId: claimed.agentWalletId,
            accountId: claimed.agentAccountId!,
            publicKeyHex: claimed.agentPublicKeyHex,
          },
          buyerAccountId,
        );
        bought.push(want);
      } catch (err) {
        // One failed purchase does not stop the round — the others were
        // planned against a balance that did not move, so they are still
        // real and still worth attempting.
        logger.error({ err, agentId: agent.id, gameId: want.gameId }, "agent purchase failed");
      }
    }
  } finally {
    // Always released back to watching, whether every purchase succeeded,
    // some did, or none did — a stuck `buying` row would silently stop this
    // agent from ever being evaluated again.
    await db.update(wishlistAgents).set({ status: "watching" }).where(eq(wishlistAgents.id, claimed.id));
  }

  if (bought.length === 0) return;

  await db.insert(agentDecisions).values({
    agentId: agent.id,
    kind: "bought",
    consideredGameIds: eligible.map((w) => w.gameId),
    chosenGameIds: bought.map((w) => w.gameId),
    reasoning: null, // deterministic — see services/agent/decide.ts
  });

  const buyer = await db.query.users.findFirst({ where: eq(users.id, agent.buyerUserId) });

  await db.insert(notifications).values({
    userId: agent.buyerUserId,
    type: "agent_purchased",
    payload: {
      agentId: agent.id,
      purchases: bought.map((w) => ({
        gameId: w.gameId,
        slug: w.slug,
        title: w.title,
        priceUnits: w.currentPriceUnits,
        priceAsset: w.asset,
      })),
    },
  });

  if (buyer) {
    void emailAgentPurchased({
      to: buyer.email,
      purchases: bought.map((w) => ({ gameTitle: w.title, priceUnits: w.currentPriceUnits, asset: w.asset })),
    }).catch((err) => logger.error({ err, agentId: agent.id }, "emailing a purchase failed"));
  }

  logger.info(
    { agentId: agent.id, bought: bought.map((w) => w.gameId) },
    "agent bought",
  );
}

/**
 * Two things a subscription cannot do on its own: anchor identity the first
 * time a wallet resolves, and end agents whose expiry has passed. Both are
 * cheap, low-frequency checks — this runs on a slow timer (index.ts), not per
 * message, and touches nothing that scales with agent count the way the old
 * per-agent poll did.
 */
export async function runAgentSweep(): Promise<{ anchored: number; expired: number }> {
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

  return { anchored, expired };
}
