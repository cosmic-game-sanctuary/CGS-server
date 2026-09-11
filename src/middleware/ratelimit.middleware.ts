import { rateLimit } from "express-rate-limit";
import { AppError } from "../lib/errors.js";

/**
 * The general rate limit.
 *
 * Two things about this were wrong until 2026-09-11 and both surfaced as a
 * paid trial dying mid-play with a bare "Request failed (429)".
 *
 * **A settling payment is four requests, not two.** `services/x402/pay.ts`
 * settles by calling our own gated route over loopback — `readChallenge` for
 * the `402`, then `settle` to pay it — so one chunk costs `prepare` +
 * `complete` from the browser plus two requests this process makes to itself.
 * Counting those against the payer means every purchase spends double its
 * real budget for traffic no client sent. A trial that meters itself buys a
 * chunk a minute, and at the old ceiling of 200 per 15 minutes it walked into
 * the wall partway through a session, every time.
 *
 * **The old ceiling was set for a quieter app than this one.** Metering,
 * notification polling and an agent page that polls while a round is pending
 * all cost requests now. 1000 per 15 minutes is roughly a request every
 * second sustained, which no person browsing produces and every runaway loop
 * does.
 */

/** Loopback, in the forms Node actually reports it. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  ipv6Subnet: 56,

  // The server settling its own x402 route. Not client traffic, and counting
  // it makes a payment cost twice what it looks like. Scoped to the settle
  // routes specifically rather than exempting loopback wholesale, because in
  // development the browser is on loopback too and deserves the same ceiling
  // everyone else gets.
  skip: (req) =>
    LOOPBACK.has(req.ip ?? "") && req.path.endsWith("/settle"),

  // express-rate-limit answers in plain text by default, which every client
  // here parses as JSON and gets nothing from — the reason this arrived on
  // screen as "Request failed (429)" with no hint that a limit even existed.
  // Routed through the normal error handler so it looks like every other
  // refusal this API makes.
  handler: (_req, _res, next) => {
    next(
      new AppError(
        429,
        "RATE_LIMITED",
        "Too many requests from this device. Wait a minute and try again.",
      ),
    );
  },
});

export default generalLimiter;
