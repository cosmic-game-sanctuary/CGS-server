import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { wishlistAgents, notifications, games } from "../db/schema.js";
import { getAccountByEvmAddress, getTopicMessages } from "../services/hedera/mirror.js";
import { anchorAgentIdentity } from "../services/agent/identity.js";
import { payForGame } from "../services/x402/pay.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.utils.js";

type Agent = typeof wishlistAgents.$inferSelect;

// The wishlist agent. Runs on a timer (see index.ts), not a subscription —
// polling a Mirror Node REST endpoint is something anyone can demonstrate as
// a single curl command, which is the whole point of "a public action anyone
// could independently build on." A gRPC subscription would be more elegant
// and much harder to show.
//
// This reads HCS_LISTINGS_TOPIC through the Mirror Node — the same public
// feed anyone could watch — never an internal "is this game published" flag.
// That distinction is the one thing in this whole project not to get wrong.
export async function runWatcherTick() {
  const agents = await db.query.wishlistAgents.findMany({
    where: inArray(wishlistAgents.status, ["draft", "funded", "watching"]),
  });

  for (const agent of agents) {
    try {
      await tickOne(agent);
    } catch (err) {
      logger.error({ err, agentId: agent.id }, "agent watcher tick failed");
    }
  }
}

async function tickOne(agent: Agent) {
  const account = await getAccountByEvmAddress(agent.agentEvmAddress);
  if (!account) return; // not funded yet — nothing else to do this tick

  if (agent.status === "draft") {
    // first time this agent's wallet resolves to a real account — this is
    // the moment its identity actually has something to anchor.
    const { aid } = await anchorAgentIdentity(agent.id, account.account, agent.agentEvmAddress);
    await db
      .update(wishlistAgents)
      .set({ status: "funded", agentAccountId: account.account, hcs14Aid: aid })
      .where(eq(wishlistAgents.id, agent.id));
    agent = { ...agent, status: "funded", agentAccountId: account.account };
  }

  const messages = await getTopicMessages(env.HCS_LISTINGS_TOPIC!, agent.lastSeenSequence);
  if (messages.length === 0) {
    if (agent.status === "funded") {
      await db.update(wishlistAgents).set({ status: "watching" }).where(eq(wishlistAgents.id, agent.id));
    }
    return;
  }

  let lastSeq = agent.lastSeenSequence;
  let triggered = false;
  for (const msg of messages) {
    lastSeq = Math.max(lastSeq, msg.sequence_number);
    const listing = JSON.parse(Buffer.from(msg.message, "base64").toString("utf8")) as {
      gameId?: string;
      priceUnits?: number;
    };
    if (listing.gameId === agent.targetGameId && (listing.priceUnits ?? Infinity) <= agent.triggerPriceUnits) {
      triggered = true;
    }
  }

  await db
    .update(wishlistAgents)
    .set({ lastSeenSequence: lastSeq, status: agent.status === "funded" ? "watching" : agent.status })
    .where(eq(wishlistAgents.id, agent.id));

  if (triggered) await fire(agent);
}

async function fire(agent: Agent) {
  logger.info({ agentId: agent.id, gameId: agent.targetGameId }, "agent firing purchase");

  try {
    await payForGame(agent.targetGameId, {
      walletId: agent.agentWalletId,
      accountId: agent.agentAccountId!,
      publicKeyHex: agent.agentPublicKeyHex,
    });
    await db.update(wishlistAgents).set({ status: "fired" }).where(eq(wishlistAgents.id, agent.id));

    // The one notification whose row has to name a game the buyer never
    // opened — they set a trigger and walked away. A bare gameId would make
    // the client fetch the game just to write the sentence.
    const game = await db.query.games.findFirst({ where: eq(games.id, agent.targetGameId) });
    await db.insert(notifications).values({
      userId: agent.buyerUserId,
      type: "agent_fired",
      payload: {
        agentId: agent.id,
        gameId: agent.targetGameId,
        slug: game?.slug ?? null,
        title: game?.title ?? null,
        priceUnits: game?.priceUnits ?? null,
        priceAsset: game?.priceAsset ?? null,
        triggerPriceUnits: agent.triggerPriceUnits,
      },
    });
  } catch (err) {
    logger.error({ err, agentId: agent.id }, "agent purchase failed");
    await db.update(wishlistAgents).set({ status: "failed" }).where(eq(wishlistAgents.id, agent.id));
  }
}
