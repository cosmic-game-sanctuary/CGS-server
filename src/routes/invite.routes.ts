import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { studioMembers, studios, notifications, splits, games } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError, Errors } from "../lib/errors.js";
import { maskEmail } from "../lib/display.js";
import { param } from "../lib/params.js";
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
      // Masked, never whole: this route needs no auth, so the full address
      // would be readable by anyone who got hold of the link. Enough to
      // recognise your own mailbox is enough for the only job it has here.
      email: maskEmail(member.email),
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

    // The link is the only thing guarding a share of real money, and a link
    // travels: forwarded, pasted into a group chat, left in a thread anyone
    // can read. Until this check existed, whoever opened it first got the
    // money — the route wrote the caller's identity onto the row without ever
    // asking whether they were the person invited. Matching the address the
    // invite was sent to is what makes the link an address rather than a
    // bearer token.
    //
    // Someone who already accepted is let through regardless: the row is
    // theirs, and a person who later changes the address on their account
    // should not be locked out of a membership they already hold.
    const alreadyTheirs = member.userId !== null && member.userId === req.auth!.id;
    const sameAddress =
      member.email.trim().toLowerCase() === req.auth!.email.trim().toLowerCase();

    if (!alreadyTheirs && !sameAddress) {
      throw new AppError(
        403,
        "INVITE_EMAIL_MISMATCH",
        `This invite was sent to ${maskEmail(member.email)}. Sign in with that address to accept it.`,
        { email: maskEmail(member.email) },
      );
    }

    if (member.acceptedAt) {
      res.json(accepted(member));
      return;
    }

    const [updated] = await db
      .update(studioMembers)
      .set({ userId: req.auth!.id, acceptedAt: new Date() })
      .where(eq(studioMembers.id, member.id))
      .returning();

    // Link every share of theirs to the account they just made, across all
    // studios — a member row is per studio, but the share is theirs.
    //
    // **The address is only rewritten on games that are still drafts.** A
    // published game's split lives in a deployed vault that names a specific
    // address, and that address cannot be changed by anyone, us included. If
    // they were invited at one email and signed in with another, their new
    // address is not the one the contract pays, and overwriting the row would
    // make this dashboard claim a destination the chain disagrees with. The
    // share is not lost either way: it accrues at the address pre-generated for
    // the invited email, which is theirs the moment they sign in with it.
    const theirs = await db.query.splits.findMany({
      where: eq(splits.studioMemberId, member.id),
      columns: { id: true, gameId: true },
    });
    if (theirs.length > 0) {
      await db.update(splits).set({ userId: req.auth!.id }).where(eq(splits.studioMemberId, member.id));

      const drafts = await db.query.games.findMany({
        where: and(inArray(games.id, [...new Set(theirs.map((t) => t.gameId))]), eq(games.status, "draft")),
        columns: { id: true },
      });
      const draftSplitIds = theirs.filter((t) => drafts.some((d) => d.id === t.gameId)).map((t) => t.id);
      if (draftSplitIds.length > 0) {
        await db.update(splits).set({ wallet: req.auth!.evmAddress }).where(inArray(splits.id, draftSplitIds));
      }

      const published = theirs.length - draftSplitIds.length;
      if (published > 0) {
        logger.info(
          { memberId: member.id, published },
          "left the payout address alone on already-published games — their vaults are immutable",
        );
      }
    }

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

    res.json(accepted(updated));
  }),
);

// What the client is told about a claimed invite. Deliberately not the whole
// row: `email` and `userId` are on it, and neither is anyone's business but
// the person the invite belongs to. Matches WireAcceptedInvite exactly.
function accepted(member: typeof studioMembers.$inferSelect) {
  return {
    id: member.id,
    studioId: member.studioId,
    handle: member.handle,
    role: member.role,
    acceptedAt: member.acceptedAt,
  };
}

export default inviteRouter;
