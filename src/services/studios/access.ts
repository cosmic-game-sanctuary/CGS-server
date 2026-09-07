import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { studios, studioMembers } from "../../db/schema.js";
import { findGameByRef } from "../games/lookup.js";

/**
 * Who is allowed to do what inside a studio.
 *
 * Three questions get asked all over this API and each was being answered
 * slightly differently wherever it came up, which is how a collaborator ended
 * up able to see a draft on one route and not another:
 *
 *   member  — accepted an invite. Sees the team's unfinished work and its
 *             earnings, because being credited on a game is reason enough to
 *             look at both.
 *   manager — the studio owner, or a member whose role is `owner`. Changes
 *             the listing: price, description, builds, whether it's listed.
 *   owner   — the `studios.owner_user_id` row and nobody else. Transfers the
 *             studio, removes people, reads member email addresses.
 *
 * Manager rather than owner for edits because a two-person team where only one
 * of them can fix a typo is the situation the invite flow exists to avoid. It
 * still isn't every member: a share of the revenue is not a mandate to reprice
 * the game.
 */

/**
 * Has this person accepted an invite to this studio, and not since left or
 * been removed? `active` is the org chart, not the credit ledger — someone who
 * left keeps every historical split forever, they just stop being "on the
 * team" for what this function gates: seeing drafts, earnings, and counting
 * toward the roster.
 */
export async function isStudioMember(studioId: string, userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const row = await db.query.studioMembers.findFirst({
    where: and(
      eq(studioMembers.studioId, studioId),
      eq(studioMembers.userId, userId),
      isNotNull(studioMembers.acceptedAt),
      eq(studioMembers.active, true),
    ),
  });
  return row !== undefined;
}

/** The founder. Not the same as "has the owner role" — see canManageStudio. */
export async function isStudioOwner(studioId: string, userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const studio = await db.query.studios.findFirst({ where: eq(studios.id, studioId) });
  return studio?.ownerUserId === userId;
}

/** The founder, or an accepted member promoted to the owner role. */
export async function canManageStudio(studioId: string, userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  if (await isStudioOwner(studioId, userId)) return true;
  const row = await db.query.studioMembers.findFirst({
    where: and(
      eq(studioMembers.studioId, studioId),
      eq(studioMembers.userId, userId),
      eq(studioMembers.role, "owner"),
      isNotNull(studioMembers.acceptedAt),
      eq(studioMembers.active, true),
    ),
  });
  return row !== undefined;
}

/**
 * The game plus a yes/no on whether this caller may change it, in one lookup.
 * Every mutating game route needs both and doing it separately meant two round
 * trips and two chances to check the wrong thing.
 */
export async function loadManageableGame(idOrSlug: string, userId: string | undefined) {
  // By slug as well as by id, like every other game route — see
  // services/games/lookup.ts for why that isn't just convenience.
  const game = await findGameByRef(idOrSlug);
  if (!game) return { game: null, canManage: false } as const;
  return { game, canManage: await canManageStudio(game.studioId, userId) } as const;
}
