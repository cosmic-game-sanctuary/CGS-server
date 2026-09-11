import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { studioMembers, studios, notifications, splits } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError, Errors } from "../lib/errors.js";
import { maskEmail } from "../lib/display.js";
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

    // Their address is known from this moment, so every split they were named
    // on stops being a placeholder. Backfilled across all of them, not just
    // this studio's — a member row is per studio, but the share is theirs.
    await db
      .update(splits)
      .set({ wallet: req.auth!.evmAddress, userId: req.auth!.id })
      .where(eq(splits.studioMemberId, member.id));

    // Anything that sold while they hadn't claimed it was held rather than
    // paid. This is where they get it — and it doesn't wait on them having a
    // Hedera account already: `settleHeldPayouts` pays their EVM alias
    // directly when no account resolves, which creates the account as a side
    // effect of this very payment. `resolveHederaAccount` is still tried
    // first purely because it's cheap and caches a real answer for every
    // other route that needs one later; nothing here is gated on it
    // succeeding. Deliberately not awaited into the response: it is one
    // transfer per sale and the screen shouldn't wait, and a failure leaves
    // the row `failed` for `npm run splits:retry`.
    void resolveHederaAccount({
      id: req.auth!.id,
      evmAddress: req.auth!.evmAddress,
      hederaAccountId: req.auth!.hederaAccountId,
    })
      .then((accountId) => settleHeldPayouts(member.id, { accountId, evmAddress: req.auth!.evmAddress }))
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
