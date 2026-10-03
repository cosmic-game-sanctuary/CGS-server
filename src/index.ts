import express, { type Express, type Request, type Response } from "express";
import helmet from "helmet";
import cors from "cors";

import { env } from "./config/env.js";
import httpLogger from "./middleware/httpLogger.js";
import generalLimiter from "./middleware/ratelimit.middleware.js";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler.middleware.js";
import { pingDb } from "./db/client.js";
import { assertAssetAgrees, operator as arcOperator, publicClient } from "./services/arc/client.js";

import gameRouter from "./routes/game.routes.js";
import gameManageRouter from "./routes/gameManage.routes.js";
import userRouter from "./routes/user.routes.js";
import studioRouter from "./routes/studio.routes.js";
import inviteRouter from "./routes/invite.routes.js";
import notificationRouter from "./routes/notification.routes.js";
import reviewRouter from "./routes/review.routes.js";
import commentRouter from "./routes/comment.routes.js";
import agentRouter from "./routes/agent.routes.js";
import agentInferenceRouter from "./routes/agentInference.routes.js";
import reportRouter from "./routes/report.routes.js";
import meRouter from "./routes/me.routes.js";
import devRouter from "./routes/dev.routes.js";
import { startAgentListener, runAgentSweep } from "./agent/watcher.js";
import { runPromotionTick } from "./services/games/promotions.js";
import logger from "./utils/logger.utils.js";

const app: Express = express();

// Load-bearing for the rate limiter and nothing else. See TRUST_PROXY in
// config/env.ts for why this is a count rather than `true`.
app.set("trust proxy", env.TRUST_PROXY);

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN.split(",").map((o) => o.trim()) }));
// Raised from 1mb for cloud saves: a 512KB save plus JSON escaping does not fit
// under 1mb, and the parser runs before any route so a per-route limit would
// never be reached. Still nowhere near a build upload, which is multipart and
// handled by multer per route rather than here.
app.use(express.json({ limit: "2mb" }));
app.use(httpLogger);
app.use(generalLimiter);

app.get("/health", async (_req: Request, res: Response) => {
  const [dbReachable, chain] = await Promise.all([pingDb(), pingArc()]);
  res.json({
    ok: dbReachable && chain.reachable,
    network: `arc-${env.ARC_NETWORK}`,
    chainId: chain.chainId,
    blockNumber: chain.blockNumber,
    operator: chain.operator,
    chainReachable: chain.reachable,
    dbReachable,
  });
});

/**
 * Is the chain answering, and are we configured to write to it?
 *
 * Reports the operator address rather than just "reachable" because the two
 * failures look identical from outside and are fixed completely differently: an
 * unreachable RPC is Arc's problem, and a missing key is ours.
 */
async function pingArc() {
  try {
    const [chainId, blockNumber] = await Promise.all([
      publicClient().getChainId(),
      publicClient().getBlockNumber(),
    ]);
    let operator: string | null = null;
    try {
      operator = arcOperator().address;
    } catch {
      operator = null; // no ARC_OPERATOR_KEY — reads work, writes do not
    }
    return { reachable: true, chainId, blockNumber: Number(blockNumber), operator };
  } catch {
    return { reachable: false, chainId: null, blockNumber: null, operator: null };
  }
}

// Before gameRouter, so its PATCH/DELETE/:id and /:id/builds land before the
// catalog's own "/:idOrSlug" gets a chance at them. Same prefix, different
// audience — see routes/gameManage.routes.ts.
app.use("/api/games", gameManageRouter);
app.use("/api/games", gameRouter);
app.use("/api/studios", studioRouter);
app.use("/api/invites", inviteRouter);
app.use("/api/notifications", notificationRouter);
app.use("/api/reviews", reviewRouter);
app.use("/api/comments", commentRouter);
// One per person, so it hangs off /api/me like /api/me/wishlist and
// /api/me/library — a singular resource, not a collection.
app.use("/api/me/agent", agentRouter);
// x402-gated, no bearer auth — a payment is the only credential this route
// checks before it starts, exactly like /api/games/:id/download. See
// routes/agentInference.routes.ts.
app.use("/api/agent", agentInferenceRouter);
app.use("/api/reports", reportRouter);
app.use("/api/me", meRouter);
app.use("/api/users", userRouter);

// Not mounted at all unless asked for, so in any other configuration the path
// 404s like anything else that doesn't exist. See routes/dev.routes.ts.
if (env.DEV_FAUCET === "on") {
  app.use("/api/dev", devRouter);
  logger.warn("DEV_FAUCET is on — /api/dev/faucet will move funds out of the operator account");
}

// Sales start and end on their own. Both halves claim their rows with a
// conditional UPDATE, so running a second process never double-applies one.
// A minute is fine: a sale is a thing measured in days, and `endsAt` is
// published, so anything reading the topic knows the deadline exactly rather
// than inferring it from when we happened to notice.
// Guarded the same way as the agent sweep below, and for the same reason: a
// tick that starts a sale announces it on HCS, which is a network call, and a
// minute is not a guarantee that the last one finished.
let ticking = false;
setInterval(() => {
  if (ticking) return;
  ticking = true;
  runPromotionTick()
    .then(({ started, ended }) => {
      if (started || ended) logger.info({ started, ended }, "promotions moved");
    })
    .catch((err) => logger.error({ err }, "promotion tick crashed"))
    .finally(() => {
      ticking = false;
    });
}, 60_000);

app.use(notFoundHandler);
app.use(errorHandler);

// Before anything binds a port. A disagreement here means every amount this
// server prints describes a different asset from the one it moves, and there
// is no symptom to notice later — see assertAssetAgrees.
assertAssetAgrees();

/**
 * The two process-level nets, and they are deliberately not symmetric.
 *
 * **An unhandled rejection is logged and survived.** Since Node 15 the default
 * is to terminate, and this server is full of intentional fire-and-forget work
 * — a mint after a settlement, an invite email, an agent's mandate going on
 * chain — where the right answer to a failure is a log line, not downtime. One
 * missed `.catch` anywhere in that set should not be able to take the process
 * with it, because what goes down with it is every in-memory payment intent:
 * everyone who is mid-purchase at that instant gets a bare
 * `PAYMENT_INTENT_EXPIRED` for something they did nothing wrong in. Each such
 * site should still carry its own handler; this is the net under them, and a
 * line here is a bug to go and fix rather than a steady state to accept.
 *
 * **An uncaught exception is logged and then the process exits.** The usual
 * argument applies and it is a real one: an exception unwound an arbitrary
 * stack, so anything it was halfway through is now in an unknown state, and
 * continuing to serve money-moving requests from that is worse than a restart.
 * Render brings it straight back, and the agent listener resumes from the
 * block it had already recorded.
 */
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection — surviving it, but this is a missing .catch somewhere");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception — exiting so a clean process replaces this one");
  process.exit(1);
});

app.listen(env.PORT, () => {
  console.log(`cgs-server listening on :${env.PORT} (arc-${env.ARC_NETWORK})`);

  // The agent's whole trigger mechanism: one subscription to the public
  // listings topic, for every agent at once — never a poll. See
  // agent/watcher.ts for why this replaced a per-agent timer.
  startAgentListener().catch((err) => logger.error({ err }, "starting the agent listener failed"));

  // Anchoring identity, expiring agents, and firing rounds whose scheduled
  // moment has come.
  //
  // **One at a time.** This used to be a bare `setInterval`, which was fair
  // when the sweep was three cheap queries that usually returned nothing. W9
  // made it the decision engine: a due round now reads every want, asks the
  // Mirror Node whether each is already owned, reads the agent's balance, and
  // may call a model and buy something. Against a database ~300ms away that
  // takes longer than the 5s interval, and `setInterval` does not care — it
  // fires anyway, so runs pile up on each other without bound. Each one holds
  // database connections and races the others for the same `buying` claim.
  //
  // The guard is the whole fix: if the last sweep has not finished, skip this
  // tick rather than start a second one.
  let sweeping = false;
  setInterval(() => {
    if (sweeping) {
      logger.warn("skipping an agent sweep because the last one is still running");
      return;
    }
    sweeping = true;
    runAgentSweep()
      .catch((err) => logger.error({ err }, "agent sweep crashed"))
      .finally(() => {
        sweeping = false;
      });
  }, env.AGENT_SWEEP_INTERVAL_MS);

  // Keepalive, and why a *server-side* one is the right shape here.
  //
  // Render's free tier spins a web service down after 15 minutes without
  // **inbound** traffic. For most apps that only costs a slow first request.
  // Here it costs the headline feature: this process holds the HCS listings
  // subscription and runs the agent sweep, so a sleeping server is an agent
  // that has stopped watching for price changes and will miss the wire it was
  // waiting for. None of the timers above count as inbound traffic — they are
  // internal, and Render never sees them.
  //
  // A request to our own public URL does count: it leaves the container, comes
  // back through Render's router, and lands as ordinary inbound traffic.
  //
  // **What this does not do: wake a service that is already asleep.** Nothing
  // running inside a stopped container can. It prevents sleep, it cannot undo
  // it — so an external monitor is still worth having, both as the belt to
  // this pair of braces and because it can alert when the service is genuinely
  // down rather than merely idle.
  //
  // **Cost, deliberately:** never sleeping means ~730 instance-hours a month
  // against a 750-hour free allowance, and a second free service would put the
  // workspace over and suspend everything. That is an acceptable trade for a
  // judging window measured in days, and a bad one to leave running for a
  // month. `KEEPALIVE_MINUTES=0` turns it off.
  if (env.RENDER_EXTERNAL_URL && env.KEEPALIVE_MINUTES > 0) {
    const target = `${env.RENDER_EXTERNAL_URL.replace(/\/+$/, "")}/health`;
    const everyMs = env.KEEPALIVE_MINUTES * 60_000;
    logger.info({ target, everyMinutes: env.KEEPALIVE_MINUTES }, "keepalive armed");

    setInterval(() => {
      // Failures are genuinely uninteresting: a missed ping just means the
      // idle timer keeps running, and the next one is minutes away. What is
      // not acceptable is an unhandled rejection taking the process down to
      // avoid a spin-down.
      void fetch(target, { signal: AbortSignal.timeout(30_000) })
        .then((res) => {
          if (!res.ok) logger.warn({ status: res.status }, "keepalive ping was not ok");
        })
        .catch((err) => logger.warn({ err: String(err) }, "keepalive ping failed"));
    }, everyMs);
  }
});
