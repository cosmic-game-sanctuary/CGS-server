import express, { type Express, type Request, type Response } from "express";
import helmet from "helmet";
import cors from "cors";

import { env } from "./config/env.js";
import httpLogger from "./middleware/httpLogger.js";
import generalLimiter from "./middleware/ratelimit.middleware.js";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler.middleware.js";
import { pingDb } from "./db/client.js";
import hederaClient from "./services/hedera/client.js";
import { pingMirror } from "./services/hedera/mirror.js";

import gameRouter from "./routes/game.routes.js";
import gameManageRouter from "./routes/gameManage.routes.js";
import userRouter from "./routes/user.routes.js";
import studioRouter from "./routes/studio.routes.js";
import inviteRouter from "./routes/invite.routes.js";
import notificationRouter from "./routes/notification.routes.js";
import reviewRouter from "./routes/review.routes.js";
import commentRouter from "./routes/comment.routes.js";
import agentRouter from "./routes/agent.routes.js";
import reportRouter from "./routes/report.routes.js";
import meRouter from "./routes/me.routes.js";
import devRouter from "./routes/dev.routes.js";
import { runWatcherTick } from "./agent/watcher.js";
import { runPromotionTick } from "./services/games/promotions.js";
import logger from "./utils/logger.utils.js";

const app: Express = express();

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
  const [dbReachable, mirrorReachable] = await Promise.all([pingDb(), pingMirror()]);
  res.json({ ok: dbReachable && mirrorReachable, network: env.HEDERA_NETWORK, operatorId: hederaClient.operatorAccountId?.toString() ?? null, mirrorReachable, dbReachable });
});

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
app.use("/api/agents", agentRouter);
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
setInterval(() => {
  runPromotionTick()
    .then(({ started, ended }) => {
      if (started || ended) logger.info({ started, ended }, "promotions moved");
    })
    .catch((err) => logger.error({ err }, "promotion tick crashed"));
}, 60_000);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`cgs-server listening on :${env.PORT} (${env.HEDERA_NETWORK})`);

  // the wishlist agent's whole loop: poll the public listings topic through
  // the Mirror Node, fire the same purchase path a person would. One tick at
  // a time, never overlapping — a slow tick delays the next one rather than
  // stacking concurrent ticks against the same agents.
  setInterval(() => {
    runWatcherTick().catch((err) => logger.error({ err }, "watcher tick crashed"));
  }, env.AGENT_POLL_INTERVAL_MS);
});
