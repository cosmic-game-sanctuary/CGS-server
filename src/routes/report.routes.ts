import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { games, moderationReports } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { Errors } from "../lib/errors.js";

const reportRouter = Router({ caseSensitive: true, strict: true });

const reportSchema = z.object({
  gameId: z.string().uuid(),
  reason: z.string().min(1).max(1000),
});

// a report delists the game immediately, before any human looks at it. the
// human review within 24h decides whether it comes back or gets removed from
// storage entirely — this route only does the immediate half.
reportRouter.post(
  "/",
  requireAuth,
  validate(reportSchema),
  asyncHandler(async (req, res) => {
    const { gameId, reason } = req.body;
    const game = await db.query.games.findFirst({ where: eq(games.id, gameId) });
    if (!game) throw Errors.notFound("Game");

    const [report] = await db
      .insert(moderationReports)
      .values({ gameId, reporterUserId: req.auth!.id, reason })
      .returning();

    if (game.status === "published") {
      await db.update(games).set({ status: "delisted" }).where(eq(games.id, gameId));
    }

    res.status(201).json(report);
  }),
);

export default reportRouter;
