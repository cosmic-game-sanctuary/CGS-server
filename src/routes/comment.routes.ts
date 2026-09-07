import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { comments, games } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { Errors } from "../lib/errors.js";
import { param } from "../lib/params.js";
import { canManageStudio } from "../services/studios/access.js";

const commentRouter = Router({ caseSensitive: true, strict: true });

const editCommentSchema = z.object({ body: z.string().min(1).max(2000) });

// Same shape as review.routes.ts's edit route: owning the comment is enough,
// nothing re-checked from the original post.
commentRouter.patch(
  "/:id",
  requireAuth,
  validate(editCommentSchema),
  asyncHandler(async (req, res) => {
    const comment = await db.query.comments.findFirst({ where: eq(comments.id, param(req, "id")) });
    if (!comment) throw Errors.notFound("Comment");
    if (comment.userId !== req.auth!.id) throw Errors.notOwner();

    const [updated] = await db
      .update(comments)
      .set({ body: req.body.body, editedAt: new Date() })
      .where(eq(comments.id, comment.id))
      .returning();

    res.json(updated);
  }),
);

// Two people can delete a comment: whoever wrote it, or a manager of the
// studio whose game it's on. The second is moderation-lite for a developer's
// own page — spam and abuse under your own listing shouldn't need a global
// moderator's attention, the same way any real storefront lets a page owner
// hide a comment on it.
commentRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const comment = await db.query.comments.findFirst({ where: eq(comments.id, param(req, "id")) });
    if (!comment) throw Errors.notFound("Comment");

    if (comment.userId !== req.auth!.id) {
      const game = await db.query.games.findFirst({ where: eq(games.id, comment.gameId) });
      const canModerate = game ? await canManageStudio(game.studioId, req.auth!.id) : false;
      if (!canModerate) throw Errors.notOwner();
    }

    await db.delete(comments).where(eq(comments.id, comment.id));
    res.json({ deleted: true, id: comment.id });
  }),
);

export default commentRouter;
