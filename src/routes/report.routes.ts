import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { games, moderationReports } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { Errors } from "../lib/errors.js";
import { fileContentReport } from "../services/moderation/contentReports.js";

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

    // `delistedBy` is what stops the developer relisting their way out of a
    // report: POST /api/games/:id/relist only undoes a delisting the developer
    // did themselves. Without it, "unlist" then "relist" is a one-click bypass.
    if (game.status === "published") {
      await db
        .update(games)
        .set({ status: "delisted", delistedBy: "moderation", updatedAt: new Date() })
        .where(eq(games.id, gameId));
    }

    res.status(201).json(report);
  }),
);

// Reviews and comments — the two user-generated surfaces the route above
// doesn't cover, because delisting a whole game over one bad review is the
// wrong tool. Kept as a separate route rather than folded into POST / with a
// discriminator: that would mean changing the shape of a route the frontend
// already calls (`{ gameId, reason }`), and there's no reason to risk it.
//
// Unlike a game report, filing one of these does **nothing automatically** —
// see the comment on `contentReports` in db/schema.ts. It only queues for a
// human, resolved via scripts/resolve-content-report.ts.
const contentReportSchema = z.object({
  targetType: z.enum(["review", "comment"]),
  targetId: z.string().uuid(),
  reason: z.string().min(1).max(1000),
});

reportRouter.post(
  "/content",
  requireAuth,
  validate(contentReportSchema),
  asyncHandler(async (req, res) => {
    const { targetType, targetId, reason } = req.body as z.infer<typeof contentReportSchema>;
    const report = await fileContentReport({
      targetType,
      targetId,
      reporterUserId: req.auth!.id,
      reason,
    });
    res.status(201).json(report);
  }),
);

export default reportRouter;
