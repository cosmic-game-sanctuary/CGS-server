import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { studios, studioMembers, splits, pendingPayouts } from "../../db/schema.js";
import { AppError, Errors } from "../../lib/errors.js";
import { emailStudioInvite } from "../email/messages.js";

/**
 * The org chart, kept separate from the credit ledger.
 *
 * `studioMembers` is who is actively on the team right now. `splits` is who
 * made what and what they are owed, forever, on every game they touched — and
 * that table is deliberately immutable once a game publishes. Removing someone
 * from the first must never touch the second: a person who leaves a studio
 * keeps every credit and every pending payout they already have. That is what
 * makes "remove a member" safe to build at all.
 *
 * The founder's own row (`studios.owner_user_id`) is protected everywhere
 * here. It cannot be removed, demoted, or left — only handed to someone else
 * via `transferOwnership`. Without that rule, a studio could end up with no
 * one able to manage it.
 */

async function requireStudio(studioId: string) {
  const studio = await db.query.studios.findFirst({ where: eq(studios.id, studioId) });
  if (!studio) throw Errors.notFound("Studio");
  return studio;
}

async function requireMember(studioId: string, memberId: string) {
  const member = await db.query.studioMembers.findFirst({
    where: and(eq(studioMembers.id, memberId), eq(studioMembers.studioId, studioId)),
  });
  if (!member) throw Errors.notFound("Member");
  return member;
}

function assertNotFounder(studio: typeof studios.$inferSelect, member: typeof studioMembers.$inferSelect) {
  if (member.userId && member.userId === studio.ownerUserId) {
    throw new AppError(
      409,
      "IS_FOUNDER",
      "This is the studio's founder. Transfer ownership to someone else first.",
    );
  }
}

/** Whether deleting this row outright would break a real promise elsewhere. */
async function isCredited(memberId: string): Promise<boolean> {
  const [split, payout] = await Promise.all([
    db.query.splits.findFirst({ where: eq(splits.studioMemberId, memberId), columns: { id: true } }),
    db.query.pendingPayouts.findFirst({ where: eq(pendingPayouts.studioMemberId, memberId), columns: { id: true } }),
  ]);
  return split !== undefined || payout !== undefined;
}

/**
 * Take someone off the active roster.
 *
 * Hard-deletes the row when nothing references it — a mis-invited email that
 * never touched a game, cleanly undone. Deactivates instead when the person is
 * credited on any split or has a payout waiting on their invite: the row has
 * to survive for those foreign keys, and it should — that credit is real and
 * permanent. Either way, `active: false` is what actually removes them from
 * the working team; the two paths differ only in whether the row itself stays.
 *
 * Idempotent: removing someone already inactive returns the current state
 * rather than erroring, the same shape as every other toggle in this API.
 */
export async function removeMember(studioId: string, memberId: string) {
  const studio = await requireStudio(studioId);
  const member = await requireMember(studioId, memberId);
  assertNotFounder(studio, member);

  if (!member.active) return { outcome: "already-inactive" as const, member };

  if (await isCredited(memberId)) {
    const [updated] = await db
      .update(studioMembers)
      .set({ active: false })
      .where(eq(studioMembers.id, memberId))
      .returning();
    return { outcome: "deactivated" as const, member: updated! };
  }

  await db.delete(studioMembers).where(eq(studioMembers.id, memberId));
  return { outcome: "deleted" as const, member };
}

/** Same operation, called by the member themselves rather than a manager. */
export async function leaveStudio(studioId: string, userId: string) {
  const member = await db.query.studioMembers.findFirst({
    where: and(eq(studioMembers.studioId, studioId), eq(studioMembers.userId, userId)),
  });
  if (!member) throw Errors.notFound("Membership");
  return removeMember(studioId, member.id);
}

export async function changeMemberRole(studioId: string, memberId: string, role: "owner" | "member") {
  const studio = await requireStudio(studioId);
  const member = await requireMember(studioId, memberId);
  assertNotFounder(studio, member);

  const [updated] = await db
    .update(studioMembers)
    .set({ role })
    .where(eq(studioMembers.id, memberId))
    .returning();
  return updated!;
}

/**
 * Re-send the invite email. Refuses on someone who already accepted — there is
 * nothing left to invite them to, and it would read as a strange thing to
 * receive.
 */
export async function resendInvite(studioId: string, memberId: string) {
  const studio = await requireStudio(studioId);
  const member = await requireMember(studioId, memberId);
  if (member.acceptedAt) {
    throw Errors.validationFailed({ memberId: "this person already accepted — there's nothing to resend" });
  }
  await emailStudioInvite({
    to: member.email,
    handle: member.handle,
    studioName: studio.name,
    inviteId: member.id,
  });
  return member;
}

/**
 * Hand the studio to someone else. Only the founder can call this — not any
 * manager — because it is the one action that changes who has ultimate
 * authority, and "any manager can appoint the next founder" is a much bigger
 * grant than "any manager can fix a typo."
 */
export async function transferOwnership(studioId: string, toMemberId: string) {
  const studio = await requireStudio(studioId);
  const target = await requireMember(studioId, toMemberId);

  if (!target.userId || !target.acceptedAt) {
    throw Errors.validationFailed({ toMemberId: "they have to have accepted their invite first" });
  }
  if (!target.active) {
    throw Errors.validationFailed({ toMemberId: "they're not an active member" });
  }
  if (target.userId === studio.ownerUserId) {
    throw Errors.validationFailed({ toMemberId: "they already own this studio" });
  }

  await db.update(studios).set({ ownerUserId: target.userId }).where(eq(studios.id, studioId));
  // The new founder needs to be able to manage immediately, regardless of what
  // their role field said a moment ago — `canManageStudio` also checks
  // `studios.owner_user_id` directly, but setting this too keeps the roster's
  // own display honest about who is in charge.
  const [updatedTarget] = await db
    .update(studioMembers)
    .set({ role: "owner" })
    .where(eq(studioMembers.id, toMemberId))
    .returning();

  return { studio: { ...studio, ownerUserId: target.userId }, newOwner: updatedTarget! };
}
