import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { studioMembers, studios, notifications } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { Errors } from "../lib/errors.js";
import { param } from "../lib/params.js";

const inviteRouter = Router({ caseSensitive: true, strict: true });

// public — reached from an emailed link, may be the first thing this person
// ever sees of CGS. no auth required just to see what it's an invite to.
inviteRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const member = await db.query.studioMembers.findFirst({
      where: eq(studioMembers.id, param(req, "id")),
    });
    if (!member) throw Errors.notFound("Invite");

    const studio = await db.query.studios.findFirst({ where: eq(studios.id, member.studioId) });
    res.json({
      handle: member.handle,
      role: member.role,
      accepted: member.acceptedAt !== null,
      studio: { id: studio!.id, name: studio!.name, slug: studio!.slug },
    });
  }),
);

// no decline endpoint on purpose — not accepting the invite is the decline,
// and it's reversible by opening the link again later.
inviteRouter.post(
  "/:id/accept",
  requireAuth,
  asyncHandler(async (req, res) => {
    const member = await db.query.studioMembers.findFirst({
      where: eq(studioMembers.id, param(req, "id")),
    });
    if (!member) throw Errors.notFound("Invite");

    if (member.acceptedAt) {
      res.json(member);
      return;
    }

    const [updated] = await db
      .update(studioMembers)
      .set({ userId: req.auth!.id, acceptedAt: new Date() })
      .where(eq(studioMembers.id, member.id))
      .returning();

    const studio = await db.query.studios.findFirst({ where: eq(studios.id, member.studioId) });
    await db.insert(notifications).values({
      userId: studio!.ownerUserId,
      type: "invite",
      payload: { studioId: studio!.id, handle: member.handle },
    });

    res.json(updated);
  }),
);

export default inviteRouter;
