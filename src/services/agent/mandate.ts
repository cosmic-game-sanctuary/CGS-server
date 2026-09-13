import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { wishlistItems, wishlistAgents } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { assetDecimals, toDisplayAmount } from "../../lib/display.js";
import {
  setSubnameAddress,
  setSubnameText,
  readSubnameText,
} from "../ens/registrar.js";
import logger from "../../utils/logger.utils.js";

type Agent = typeof wishlistAgents.$inferSelect;

/**
 * An agent's spending mandate, published on its own ENS name and read back
 * before it spends.
 *
 * **Why this exists.** An agent buys with nobody watching. Until now the only
 * statement of what it was *allowed* to spend lived in our database, so
 * "this agent will never pay more than $4 for a game" was a claim you could
 * only take our word for. Written to the agent's own name it becomes a fact
 * anyone can read off Sepolia, and — because `ceilingFromChain` gates the
 * purchase — one we cannot quietly exceed either.
 *
 * The records:
 *
 *   cgs:role       always "agent"
 *   cgs:account    the Hedera account it actually spends from
 *   cgs:maxSpend   the most it will pay for any single game, in display units
 *   cgs:mode       autonomous | ask_first
 *
 * **`cgs:maxSpend` is a per-purchase ceiling, not a total budget.** The total
 * is already public and always was: it is the balance of the agent's own
 * account, which anyone can read from the Mirror Node. What was missing is
 * the *rule*, and this is that.
 */

/**
 * The largest single purchase this agent is currently trusted with — the
 * highest ceiling across everything its buyer is watching.
 *
 * Derived rather than stored, like every other money figure in this codebase:
 * a stored copy is a second source that disagrees with the first the moment a
 * want changes.
 */
export async function ceilingUnitsFor(agent: Agent): Promise<number> {
  const wants = await db.query.wishlistItems.findMany({
    where: eq(wishlistItems.userId, agent.buyerUserId),
    columns: { agentMaxUnits: true },
  });
  return wants.reduce((max, w) => (w.agentMaxUnits && w.agentMaxUnits > max ? w.agentMaxUnits : max), 0);
}

/**
 * One publish at a time per agent.
 *
 * Each publish is four Sepolia transactions from a single operator key, so two
 * overlapping runs would race for the same nonce and one would be thrown away.
 * Callers fire this and forget, and a buyer adjusting two wants in quick
 * succession is completely ordinary, so the overlap is expected rather than
 * exotic. The later call is dropped rather than queued: it is about to be made
 * redundant by a newer one anyway, and `ceilingUnitsFor` always reads current
 * state when it does run.
 */
const publishing = new Set<string>();

/**
 * Write the mandate to chain. Fire-and-forget: **never throws, never blocks a
 * request.**
 *
 * Four chain writes take the best part of a minute, which has no business
 * inside an HTTP handler, and a Sepolia hiccup must never be the reason a
 * buyer cannot change their own wishlist. A failure here leaves the previous
 * records in place — stale, and logged as such, rather than wrong in a
 * direction that lets the agent spend more.
 */
export async function publishAgentMandate(agent: Agent): Promise<void> {
  if (!agent.ensLabel) return; // no name, nothing to publish it on
  if (publishing.has(agent.id)) {
    logger.info({ agentId: agent.id }, "mandate publish already running, skipping the duplicate");
    return;
  }

  publishing.add(agent.id);
  try {
    const resolver = env.ENS_RESOLVER as `0x${string}`;
    const label = agent.ensLabel;
    const ceiling = await ceilingUnitsFor(agent);

    await setSubnameAddress(resolver, label, agent.agentEvmAddress as `0x${string}`);
    await setSubnameText(resolver, label, "cgs:role", "agent");
    await setSubnameText(resolver, label, "cgs:account", agent.agentAccountId ?? "");
    await setSubnameText(resolver, label, "cgs:maxSpend", String(toDisplayAmount(ceiling, env.X402_ASSET)));
    await setSubnameText(resolver, label, "cgs:mode", agent.mode);

    logger.info(
      { agentId: agent.id, label, maxSpend: toDisplayAmount(ceiling, env.X402_ASSET), mode: agent.mode },
      "agent mandate published to ENS",
    );
  } catch (err) {
    logger.error({ err, agentId: agent.id }, "publishing the agent mandate failed — records are now stale");
  } finally {
    publishing.delete(agent.id);
  }
}

/** Publish without making the caller wait or handle a failure. */
export function publishAgentMandateInBackground(agent: Agent): void {
  void publishAgentMandate(agent);
}

/**
 * The per-purchase ceiling **as published on chain**, in smallest units.
 *
 * Null means "no ceiling is being claimed publicly" and the caller should fall
 * back to its own reckoning. That happens in two ways, and neither is a fault:
 * an agent with no ENS name has nothing to read, and Sepolia being briefly
 * unreachable is not a reason to stop a Hedera purchase the buyer already
 * authorised. Returning null rather than throwing is what keeps a name
 * optional instead of load-bearing for agents that never asked for one.
 */
export async function ceilingFromChain(agent: Agent): Promise<number | null> {
  if (!agent.ensLabel) return null;
  try {
    const raw = await readSubnameText(env.ENS_RESOLVER as `0x${string}`, agent.ensLabel, "cgs:maxSpend");
    if (!raw) return null;
    const display = Number(raw);
    if (!Number.isFinite(display) || display < 0) return null;
    // Display units back to integer units. Rounded because the record is
    // written for a human to read ("4", "0.5") and a float multiplied by
    // 10^decimals lands a hair either side of the integer it means.
    return Math.round(display * 10 ** assetDecimals(env.X402_ASSET));
  } catch (err) {
    logger.warn({ err, agentId: agent.id }, "could not read the published mandate — falling back to local limits");
    return null;
  }
}
