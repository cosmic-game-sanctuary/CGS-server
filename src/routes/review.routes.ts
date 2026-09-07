import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { reviews, games, notifications } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { Errors } from "../lib/errors.js";
import { param } from "../lib/params.js";
import { canManageStudio } from "../services/studios/access.js";

const reviewRouter = Router({ caseSensitive: true, strict: true });

const editReviewSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  body: z.string().min(1).max(2000).optional(),
});

// ownership isn't re-checked on edit — only at the original post (see
// game.routes.ts). Owning the review itself is enough here.
reviewRouter.patch(
  "/:id",
  requireAuth,
  validate(editReviewSchema),
  asyncHandler(async (req, res) => {
    const review = await db.query.reviews.findFirst({ where: eq(reviews.id, param(req, "id")) });
    if (!review) throw Errors.notFound("Review");
    if (review.userId !== req.auth!.id) throw Errors.notOwner();

    const [updated] = await db
      .update(reviews)
      .set({ ...req.body, editedAt: new Date() })
      .where(eq(reviews.id, review.id))
      .returning();

    res.json(updated);
  }),
);

// A reviewer taking down their own words. No studio involvement — a review is
// a verified-purchase opinion, not a listing, and only the person who wrote it
// gets to remove it.
reviewRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const review = await db.query.reviews.findFirst({ where: eq(reviews.id, param(req, "id")) });
    if (!review) throw Errors.notFound("Review");
    if (review.userId !== req.auth!.id) throw Errors.notOwner();

    await db.delete(reviews).where(eq(reviews.id, review.id));
    res.json({ deleted: true, id: review.id });
  }),
);

// --- the developer's voice --------------------------------------------------
//
// One reply per review, from the studio rather than a named person — the same
// way the listing itself speaks for the studio. This is the thing "no way to
// reply to a review" pointed at: a developer with no voice on their own page.

const replySchema = z.object({ body: z.string().min(1).max(2000) });

reviewRouter.post(
  "/:id/reply",
  requireAuth,
  validate(replySchema),
  asyncHandler(async (req, res) => {
    const review = await db.query.reviews.findFirst({ where: eq(reviews.id, param(req, "id")) });
    if (!review) throw Errors.notFound("Review");

    const game = await db.query.games.findFirst({ where: eq(games.id, review.gameId) });
    if (!game) throw Errors.notFound("Game");
    if (!(await canManageStudio(game.studioId, req.auth!.id))) throw Errors.notOwner();

    const isFirstReply = review.developerReply === null;

    const [updated] = await db
      .update(reviews)
      .set({
        developerReply: req.body.body,
        developerReplyAt: new Date(),
        developerReplyByUserId: req.auth!.id,
      })
      .where(eq(reviews.id, review.id))
      .returning();

    // Only on the first reply, not on an edit of it — otherwise fixing a typo
    // in your own reply pings the reviewer again for no new reason.
    if (isFirstReply) {
      await db.insert(notifications).values({
        userId: review.userId,
        type: "review_reply",
        payload: { reviewId: review.id, gameId: game.id, slug: game.slug, title: game.title },
      });
    }

    res.json(updated);
  }),
);

reviewRouter.delete(
  "/:id/reply",
  requireAuth,
  asyncHandler(async (req, res) => {
    const review = await db.query.reviews.findFirst({ where: eq(reviews.id, param(req, "id")) });
    if (!review) throw Errors.notFound("Review");

    const game = await db.query.games.findFirst({ where: eq(games.id, review.gameId) });
    if (!game) throw Errors.notFound("Game");
    if (!(await canManageStudio(game.studioId, req.auth!.id))) throw Errors.notOwner();

    const [updated] = await db
      .update(reviews)
      .set({ developerReply: null, developerReplyAt: null, developerReplyByUserId: null })
      .where(eq(reviews.id, review.id))
      .returning();

    res.json(updated);
  }),
);

export default reviewRouter;
