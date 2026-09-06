import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { studioMembers, studios, notifications, splits } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { Errors } from "../lib/errors.js";
import { param } from "../lib/params.js";
import { settleHeldPayouts } from "../services/games/fulfil.js";
import { resolveHederaAccount } from "../services/users/repo.js";
import logger from "../utils/logger.utils.js";

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

    // Their address is known from this moment, so every split they were named
    // on stops being a placeholder. Backfilled across all of them, not just
    // this studio's — a member row is per studio, but the share is theirs.
    await db
      .update(splits)
      .set({ wallet: req.auth!.evmAddress, userId: req.auth!.id })
      .where(eq(splits.studioMemberId, member.id));

    // Anything that sold while they hadn't claimed it was held rather than
    // paid. This is where they get it. Deliberately not awaited into the
    // response: it is one transfer per sale and the screen shouldn't wait,
    // and a failure leaves the row `failed` for `npm run splits:retry`.
    void resolveHederaAccount({
      id: req.auth!.id,
      evmAddress: req.auth!.evmAddress,
      hederaAccountId: req.auth!.hederaAccountId,
    })
      .then((accountId) => (accountId ? settleHeldPayouts(member.id, accountId) : 0))
      .then((settled) => {
        if (settled > 0) logger.info({ memberId: member.id, settled }, "settled held payouts on invite accept");
      })
      .catch((err) => logger.error({ err, memberId: member.id }, "settling held payouts failed"));

    const studio = await db.query.studios.findFirst({ where: eq(studios.id, member.studioId) });
    await db.insert(notifications).values({
      userId: studio!.ownerUserId,
      type: "invite",
      payload: {
        studioId: studio!.id,
        studioSlug: studio!.slug,
        studioName: studio!.name,
        handle: member.handle,
      },
    });

    res.json(updated);
  }),
);

export default inviteRouter;
