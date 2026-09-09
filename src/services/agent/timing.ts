import { env } from "../../config/env.js";

/**
 * The two clocks from wishlist-agent-spec.md §4 — a sale's own `endsAt`,
 * which is fixed and public, and the agent's `decideBy`, which it chooses.
 * Both a hold and an ask-first question live inside the same wall: never
 * later than `endsAt - purchaseBuffer`, so there is always enough time left
 * to actually execute a purchase (Mirror Node lag, a failed settlement, one
 * retry) after the decision is made.
 */

/**
 * Floor for executing a decision once it's made. An hour is safe, and an hour
 * is the default. Overridable through `AGENT_PURCHASE_BUFFER_MS` for the sole
 * purpose of not having to wait an hour to watch this work.
 */
export const PURCHASE_BUFFER_MS = env.AGENT_PURCHASE_BUFFER_MS;

/** Enough time for a human who is asleep. */
export const ASK_WINDOW_MS = 18 * 60 * 60 * 1000;

/**
 * **The wire: the last responsible moment to decide about a sale.**
 *
 * An hour before it ends, which is `PURCHASE_BUFFER_MS` — the same constant
 * that bounds a hold and that a studio winding a sale down has to honour. One
 * number, three uses, and they have to be the same number or the guarantee
 * breaks: an agent that waits until the wire is only safe if nothing can take
 * the price away inside it.
 *
 * Why wait at all, when the money is there and the price is already right?
 * Because a sale is open until it ends, so waiting costs nothing, and what
 * *arrives* while you wait costs everything. Two games a buyer wants almost
 * never go on sale in the same second. Spending on the first one to get cheap
 * is not a choice between them; it is a race between two studios pressing a
 * button, and the buyer's agent had no part in it. Deciding at the wire is the
 * difference between an agent and a standing order.
 *
 * Null when no sale is running: nothing is scheduled to expire, so there is no
 * moment that is later than all the others.
 */
export function wireFor(endsAt: Date | null): Date | null {
  return endsAt ? new Date(endsAt.getTime() - PURCHASE_BUFFER_MS) : null;
}

/**
 * Whether there is genuinely time to ask a person before a sale ends. No
 * `endsAt` at all (a plain price drop, nothing scheduled to revert) means no
 * external clock is running, so there is always time.
 */
export function canAsk(endsAt: Date | null, now = new Date()): boolean {
  if (!endsAt) return true;
  return endsAt.getTime() - now.getTime() > ASK_WINDOW_MS + PURCHASE_BUFFER_MS;
}

/**
 * When a hold or a question must resolve by. Bounded by `endsAt -
 * purchaseBuffer` when a sale is running; otherwise bounded only by the
 * agent's own requested wait. Never in the past — a request that already
 * blew the buffer resolves now, not never.
 */
export function decideByFor(
  endsAt: Date | null,
  requestedHours: number,
  now = new Date(),
): Date {
  const requested = new Date(now.getTime() + Math.max(0, requestedHours) * 60 * 60 * 1000);
  if (!endsAt) return requested;

  const wall = new Date(endsAt.getTime() - PURCHASE_BUFFER_MS);
  return requested.getTime() < wall.getTime() ? requested : wall;
}
