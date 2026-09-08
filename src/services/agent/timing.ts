/**
 * The two clocks from wishlist-agent-spec.md §4 — a sale's own `endsAt`,
 * which is fixed and public, and the agent's `decideBy`, which it chooses.
 * Both a hold and an ask-first question live inside the same wall: never
 * later than `endsAt - purchaseBuffer`, so there is always enough time left
 * to actually execute a purchase (Mirror Node lag, a failed settlement, one
 * retry) after the decision is made.
 */

/** Floor for executing a decision once it's made. An hour is safe. */
export const PURCHASE_BUFFER_MS = 60 * 60 * 1000;

/** Enough time for a human who is asleep. */
export const ASK_WINDOW_MS = 18 * 60 * 60 * 1000;

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
