import { Router } from "express";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { notifications } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { Errors } from "../lib/errors.js";
import { param } from "../lib/params.js";
import { toDisplayAmount } from "../lib/display.js";
import { env } from "../config/env.js";

const notificationRouter = Router({ caseSensitive: true, strict: true });

// A payload stores money the way everything else does, in integer units. The
// rows that render it are ledger lines and need a figure to print, and the
// decimals to derive one live only here — same reasoning as `priceUsd` on a
// game (lib/display.ts). Done on read rather than at write time so rows
// already in the table get it too.
const UNIT_FIELDS = ["shareUnits", "priceUnits", "triggerPriceUnits"] as const;

function withDisplayAmounts(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;

  const record = payload as Record<string, unknown>;
  const asset = typeof record.priceAsset === "string" ? record.priceAsset : env.X402_ASSET;
  const out: Record<string, unknown> = { ...record };

  for (const field of UNIT_FIELDS) {
    const units = record[field];
    if (typeof units !== "number") continue;
    out[field.replace(/Units$/, "Usd")] = toDisplayAmount(units, asset);
  }
  return out;
}

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
      notifications: page.map((n) => ({ ...n, payload: withDisplayAmounts(n.payload) })),
      nextCursor: hasMore ? page[page.length - 1]!.createdAt.toISOString() : null,
    });
  }),
);

// "Mark all read" is one gesture and should be one request. Doing it per row
// from the client meant thirty POSTs against a rate limiter set to 200 per
// fifteen minutes.
notificationRouter.post(
  "/read-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    const updated = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, req.auth!.id), isNull(notifications.readAt)))
      .returning({ id: notifications.id });

    res.json({ read: updated.length });
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
