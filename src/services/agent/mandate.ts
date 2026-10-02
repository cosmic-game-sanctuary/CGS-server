import { eq } from "drizzle-orm";
import { hexToBigInt, toHex } from "viem";
import { db } from "../../db/client.js";
import { wishlistItems, wishlistAgents } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { setSubnameAddress, setSubnameText } from "../ens/registrar.js";
import { MAX_SPEND_KEY, readMetadata, writeMetadata } from "./identity.js";
import logger from "../../utils/logger.utils.js";

type Agent = typeof wishlistAgents.$inferSelect;

/**
 * An agent's spending mandate: published on chain, and read back before it spends.
 *
 * **Why this exists.** An agent buys with nobody watching. The only statement of
 * what it was *allowed* to spend used to live in our database, so "this agent
 * will never pay more than $4 for a game" was a claim you could only take our
 * word for. Published on chain it becomes a fact anyone can read, and — because
 * `ceilingFromChain` gates the purchase — one we cannot quietly exceed either.
 *
 * **The ceiling moved from ENS to the ERC-8004 registry, and that is the whole
 * point of the change.** It used to be a `cgs:maxSpend` text record on the
 * agent's ENS name on *Sepolia*, while the money moved on Hedera and now Arc.
 * A rule published on a different chain from the spending it governs has two
 * problems: a reader has to know to look somewhere else, and an outage on the
 * chain that holds the rule has nothing to do with the chain that holds the
 * money. It is now `cgs:maxSpendUnits` metadata on the agent's own ERC-8004
 * token, on Arc, next to the balance it limits and readable in the same call.
 *
 * ENS keeps what it is good at — a human-readable name, the agent's address, its
 * role and its mode — and no longer carries the enforced number, so there is
 * exactly one source for it.
 *
 * **It is a per-purchase ceiling, not a total budget.** The total is already
 * public and always was: the balance of the agent's own wallet, which anyone can
 * read. What was missing is the *rule*, and this is that.
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
 * Several chain writes from one key each time, so two overlapping runs would
 * race for the same nonce and one would be thrown away. Callers fire this and
 * forget, and a buyer adjusting two wants in quick succession is completely
 * ordinary, so the overlap is expected rather than exotic. The later call is
 * dropped rather than queued: it is about to be made redundant by a newer one
 * anyway, and `ceilingUnitsFor` always reads current state when it does run.
 */
const publishing = new Set<string>();

/**
 * Write the mandate to chain. Fire-and-forget: **never throws, never blocks a
 * request.**
 *
 * Several chain writes take real time, which has no business inside an HTTP
 * handler, and a chain hiccup must never be the reason a buyer cannot change
 * their own wishlist. A failure here leaves the previous value in place —
 * stale, and logged as such, rather than wrong in a direction that lets the
 * agent spend more.
 */
export async function publishAgentMandate(agent: Agent): Promise<void> {
  // Deliberately *not* gated on having an ENS name any more. It used to return
  // here, which was right when the mandate lived entirely on ENS and is wrong
  // now: the enforced ceiling is on the agent's ERC-8004 token, and an agent
  // that never asked for a name still needs one published.
  if (publishing.has(agent.id)) {
    logger.info({ agentId: agent.id }, "mandate publish already running, skipping the duplicate");
    return;
  }

  publishing.add(agent.id);
  try {
    const ceiling = await ceilingUnitsFor(agent);

    // **The enforced number goes on chain first, and on its own.** It is what
    // `ceilingFromChain` reads before every purchase, so it must not be held
    // up by — or fail alongside — four Sepolia writes that only affect how the
    // agent is displayed. Integer units, not display dollars: this is read by
    // code, and the float round-trip through "0.5" was a needless place to
    // lose a unit.
    if (agent.erc8004AgentId) {
      // A 32-byte big-endian word, the natural encoding for a uint — see the
      // note on the metadata keys in identity.ts.
      const txHash = await writeMetadata(
        agent,
        BigInt(agent.erc8004AgentId),
        MAX_SPEND_KEY,
        toHex(BigInt(ceiling), { size: 32 }),
      );
      logger.info(
        { agentId: agent.id, erc8004AgentId: agent.erc8004AgentId, ceilingUnits: ceiling, txHash },
        "agent spending ceiling published to its ERC-8004 token",
      );
    }

    // The name, which is presentation. Deliberately after the ceiling and in
    // its own try: an agent with no ENS name is completely normal, and a
    // Sepolia hiccup must never be why a mandate did not reach Arc.
    if (!agent.ensLabel) return;
    try {
      const resolver = env.ENS_RESOLVER as `0x${string}`;
      const label = agent.ensLabel;
      await setSubnameAddress(resolver, label, agent.agentEvmAddress as `0x${string}`);
      await setSubnameText(resolver, label, "cgs:role", "agent");
      await setSubnameText(resolver, label, "cgs:agentId", agent.erc8004AgentId ?? "");
      await setSubnameText(resolver, label, "cgs:mode", agent.mode);
      logger.info({ agentId: agent.id, label, mode: agent.mode }, "agent name records published to ENS");
    } catch (err) {
      logger.error({ err, agentId: agent.id }, "publishing the agent's ENS records failed — the name is stale, the ceiling is not");
    }
  } catch (err) {
    logger.error({ err, agentId: agent.id }, "publishing the agent mandate failed — the on-chain ceiling is now stale");
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
 * back to its own reckoning. That happens when an agent has not been registered
 * yet, or when nothing has been written against its token — neither is a fault,
 * and an agent nobody has published a rule for must not start behaving
 * differently because this code exists.
 *
 * **It can only ever refuse a purchase, never permit one.** That asymmetry is
 * why returning null on a read failure is safe: the worst case is falling back
 * to the limits we already enforce locally, not quietly lifting a cap.
 */
export async function ceilingFromChain(agent: Agent): Promise<number | null> {
  if (!agent.erc8004AgentId) return null;
  try {
    const raw = await readMetadata(BigInt(agent.erc8004AgentId), MAX_SPEND_KEY);
    if (!raw || raw === "0x") return null;
    const units = hexToBigInt(raw);

    // **Zero is read as "nothing published", not as "spend nothing".** The
    // written value is the highest ceiling across the buyer's wants, so it is
    // genuinely zero only when they have no wants with a maximum — in which
    // case nothing is eligible and the distinction cannot matter. What it
    // protects against is the case that actually bit: an agent registered in
    // the instant before its first want existed published a 0, and a 0 that
    // means "refuse everything" locked it out of every purchase afterwards.
    // Treating it as unpublished loses no safety (eligibility already requires
    // a want with a maximum) and removes a way for a stale write to silently
    // disable an agent.
    if (units === 0n) return null;
    // Beyond Number.MAX_SAFE_INTEGER this is not a real ceiling, it is a
    // corrupted read, and clamping it would be the wrong direction.
    if (units > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(units);
  } catch (err) {
    logger.warn({ err, agentId: agent.id }, "could not read the published mandate — falling back to local limits");
    return null;
  }
}
