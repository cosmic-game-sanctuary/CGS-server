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
import studioRouter from "./routes/studio.routes.js";
import inviteRouter from "./routes/invite.routes.js";
import notificationRouter from "./routes/notification.routes.js";
import reviewRouter from "./routes/review.routes.js";
import agentRouter from "./routes/agent.routes.js";
import reportRouter from "./routes/report.routes.js";
import { runWatcherTick } from "./agent/watcher.js";
import logger from "./utils/logger.utils.js";

const app: Express = express();

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN.split(",").map((o) => o.trim()) }));
app.use(express.json({ limit: "1mb" })); // doesn't touch multipart — multer parses that per route
app.use(httpLogger);
app.use(generalLimiter);

app.get("/health", async (_req: Request, res: Response) => {
  const [dbReachable, mirrorReachable] = await Promise.all([pingDb(), pingMirror()]);
  res.json({ ok: dbReachable && mirrorReachable, network: env.HEDERA_NETWORK, operatorId: hederaClient.operatorAccountId?.toString() ?? null, mirrorReachable, dbReachable });
});

app.use("/api/games", gameRouter);
app.use("/api/studios", studioRouter);
app.use("/api/invites", inviteRouter);
app.use("/api/notifications", notificationRouter);
app.use("/api/reviews", reviewRouter);
app.use("/api/agents", agentRouter);
app.use("/api/reports", reportRouter);

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
