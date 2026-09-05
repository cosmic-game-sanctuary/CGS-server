import { Router } from "express";
import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { notifications } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { Errors } from "../lib/errors.js";
import { param } from "../lib/params.js";

const notificationRouter = Router({ caseSensitive: true, strict: true });

const listSchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(50).default(20),
});

notificationRouter.get(
  "/",
  requireAuth,
  validate(listSchema, "query"),
  asyncHandler(async (req, res) => {
    const { cursor, limit } = req.query as unknown as z.infer<typeof listSchema>;

    const rows = await db.query.notifications.findMany({
      where: and(
        eq(notifications.userId, req.auth!.id),
        cursor ? lt(notifications.createdAt, new Date(cursor)) : undefined,
      ),
      orderBy: desc(notifications.createdAt),
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    res.json({
      notifications: page,
      nextCursor: hasMore ? page[page.length - 1]!.createdAt.toISOString() : null,
    });
  }),
);

notificationRouter.post(
  "/:id/read",
  requireAuth,
  asyncHandler(async (req, res) => {
    const notification = await db.query.notifications.findFirst({
      where: eq(notifications.id, param(req, "id")),
    });
    if (!notification) throw Errors.notFound("Notification");
    if (notification.userId !== req.auth!.id) throw Errors.notOwner();

    const [updated] = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(eq(notifications.id, notification.id))
      .returning();

    res.json(updated);
  }),
);

export default notificationRouter;
