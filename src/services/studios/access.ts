import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { studios, studioMembers, games } from "../../db/schema.js";
import { isUuid } from "../../lib/params.js";

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

/** Has this person accepted an invite to this studio? */
export async function isStudioMember(studioId: string, userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const row = await db.query.studioMembers.findFirst({
    where: and(
      eq(studioMembers.studioId, studioId),
      eq(studioMembers.userId, userId),
      isNotNull(studioMembers.acceptedAt),
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
    ),
  });
  return row !== undefined;
}

/**
 * The game plus a yes/no on whether this caller may change it, in one lookup.
 * Every mutating game route needs both and doing it separately meant two round
 * trips and two chances to check the wrong thing.
 */
export async function loadManageableGame(gameId: string, userId: string | undefined) {
  // Comparing a non-uuid against a uuid column makes Postgres throw
  // "invalid input syntax for type uuid", which surfaces as a 500 on what is
  // really a 404. See lib/params.ts#isUuid.
  if (!isUuid(gameId)) return { game: null, canManage: false } as const;
  const game = await db.query.games.findFirst({ where: eq(games.id, gameId) });
  if (!game) return { game: null, canManage: false } as const;
  return { game, canManage: await canManageStudio(game.studioId, userId) } as const;
}
