import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { reviews } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { Errors } from "../lib/errors.js";
import { param } from "../lib/params.js";

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

export default reviewRouter;
