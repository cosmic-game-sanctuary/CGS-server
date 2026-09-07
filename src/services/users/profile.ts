import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  users,
  studios,
  studioMembers,
  games,
  splits,
  reviews,
  playSessions,
  gameKeys,
  likes,
} from "../../db/schema.js";
import { truncateAddress } from "../../lib/address.js";
import { ensFullName } from "../../lib/display.js";
import { gatewayUrl } from "../ipfs/pinata.js";

/**
 * Who somebody is, in public.
 *
 * Before this, every person on the site rendered as a truncated address. A
 * reviewer had no history you could check, a name in a game's credits led
 * nowhere, and nobody had a page of their own — which is also why the profile
 * dropdown kept growing: it was the only place anything personal could go.
 *
 * Two rules hold everywhere in this file:
 *
 *   Email is never public. It is on the users row and it is not in any shape
 *   returned from here.
 *
 *   Ownership shown on a profile comes from the `gameKeys` cache, not the
 *   Mirror Node. That is allowed *because nothing here grants anything* — this
 *   decides what a page displays, not who may play. Everything that gates
 *   access still asks the mirror (services/games/ownership.ts). The alternative
 *   would be a full NFT walk per profile view.
 */

export type AuthorSummary = {
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  address: string;
  /** What to print when there is no handle yet. */
  label: string;
};

/**
 * Identity for a set of user ids, in one query.
 *
 * Reviews and comments both need this and both used to do their own truncated-
 * address lookup, so the two lists disagreed about how to name the same person.
 */
export async function authorSummaries(userIds: string[]): Promise<Map<string, AuthorSummary>> {
  const out = new Map<string, AuthorSummary>();
  if (userIds.length === 0) return out;

  const rows = await db.query.users.findMany({
    where: inArray(users.id, [...new Set(userIds)]),
    columns: { id: true, handle: true, displayName: true, avatarCid: true, evmAddress: true },
  });

  for (const r of rows) {
    out.set(r.id, {
      handle: r.handle,
      displayName: r.displayName,
      avatarUrl: r.avatarCid ? gatewayUrl(r.avatarCid) : null,
      address: r.evmAddress,
      label: r.displayName || r.handle || truncateAddress(r.evmAddress),
    });
  }
  return out;
}

/** Every studio membership this person has accepted, with the studio attached. */
async function studiosFor(userId: string) {
  const memberships = await db.query.studioMembers.findMany({
    where: eq(studioMembers.userId, userId),
  });
  const accepted = memberships.filter((m) => m.acceptedAt !== null);
  if (accepted.length === 0) return { memberships, studios: [] as (typeof studios.$inferSelect & { role: string })[] };

  const rows = await db.query.studios.findMany({
    where: inArray(studios.id, accepted.map((m) => m.studioId)),
  });
  const roleByStudio = new Map(accepted.map((m) => [m.studioId, m.role as string]));
  return {
    memberships,
    studios: rows.map((s) => ({ ...s, role: s.ownerUserId === userId ? "owner" : (roleByStudio.get(s.id) ?? "member") })),
  };
}

/**
 * Games this person is credited on, with the share they hold.
 *
 * This is the thing no other storefront can show. Steam names a publisher and
 * itch names an uploader; a split names everyone who made it and proves what
 * each of them is paid. It was already in the database and nothing rendered it
 * as credit.
 */
async function creditsFor(userId: string, memberIds: string[]) {
  const rows = await db.query.splits.findMany({
    where: memberIds.length
      ? or(eq(splits.userId, userId), inArray(splits.studioMemberId, memberIds))
      : eq(splits.userId, userId),
  });
  if (rows.length === 0) return [];

  const gameRows = await db.query.games.findMany({
    where: and(inArray(games.id, rows.map((r) => r.gameId)), ne(games.status, "removed")),
    with: { studio: true },
  });
  // A draft is work its studio has not announced. Someone else's profile is not
  // the place it leaks from.
  const byId = new Map(gameRows.filter((g) => g.status !== "draft").map((g) => [g.id, g]));

  return rows
    .filter((r) => byId.has(r.gameId))
    .map((r) => {
      const game = byId.get(r.gameId)!;
      return {
        gameId: game.id,
        slug: game.slug,
        title: game.title,
        coverCid: game.coverCid,
        coverUrl: game.coverCid ? gatewayUrl(game.coverCid) : null,
        coverSeed: game.coverSeed,
        status: game.status,
        studio: { id: game.studio.id, name: game.studio.name, slug: game.studio.slug },
        role: r.role,
        pct: r.pct,
        publishedAt: game.publishedAt,
      };
    })
    .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
}

/** What this person owns, from the key cache. Only when they allow it. */
async function libraryFor(userId: string, hederaAccountId: string | null) {
  if (!hederaAccountId) return [];
  const keys = await db.query.gameKeys.findMany({
    where: and(eq(gameKeys.ownerAccountId, hederaAccountId), eq(gameKeys.mintStatus, "confirmed")),
    columns: { gameId: true },
  });
  const gameIds = [...new Set(keys.map((k) => k.gameId))];
  if (gameIds.length === 0) return [];

  const rows = await db.query.games.findMany({
    where: and(inArray(games.id, gameIds), ne(games.status, "removed")),
    with: { studio: true },
  });

  const sessions = await db.query.playSessions.findMany({
    where: and(eq(playSessions.userId, userId), inArray(playSessions.gameId, gameIds)),
    columns: { gameId: true, durationSeconds: true },
  });
  const played = new Map<string, number>();
  for (const s of sessions) played.set(s.gameId, (played.get(s.gameId) ?? 0) + (s.durationSeconds ?? 0));

  return rows.map((g) => ({
    gameId: g.id,
    slug: g.slug,
    title: g.title,
    coverCid: g.coverCid,
    coverUrl: g.coverCid ? gatewayUrl(g.coverCid) : null,
    coverSeed: g.coverSeed,
    studio: { id: g.studio.id, name: g.studio.name, slug: g.studio.slug },
    playtimeSeconds: played.get(g.id) ?? 0,
  }));
}

/** The public page for a handle, or null if nobody has it. */
export async function publicProfile(handle: string, viewerId?: string) {
  const user = await db.query.users.findFirst({ where: eq(users.handle, handle.toLowerCase()) });
  if (!user) return null;

  const isSelf = viewerId === user.id;
  const { memberships, studios: memberStudios } = await studiosFor(user.id);

  const [credits, reviewRows, sessions, likeRows] = await Promise.all([
    creditsFor(user.id, memberships.map((m) => m.id)),
    db.query.reviews.findMany({
      where: eq(reviews.userId, user.id),
      orderBy: desc(reviews.createdAt),
      limit: 20,
    }),
    db.query.playSessions.findMany({
      where: eq(playSessions.userId, user.id),
      columns: { durationSeconds: true },
    }),
    db.query.likes.findMany({ where: eq(likes.userId, user.id), columns: { gameId: true } }),
  ]);

  const reviewedGameIds = [...new Set(reviewRows.map((r) => r.gameId))];
  const reviewedGames = reviewedGameIds.length
    ? await db.query.games.findMany({
        where: inArray(games.id, reviewedGameIds),
        columns: { id: true, slug: true, title: true, coverCid: true, coverSeed: true, status: true },
      })
    : [];
  const gameById = new Map(reviewedGames.map((g) => [g.id, g]));

  const showLibrary = user.libraryPublic || isSelf;
  const library = showLibrary ? await libraryFor(user.id, user.hederaAccountId) : [];

  return {
    handle: user.handle,
    displayName: user.displayName,
    // What to print. Falls back the same way everywhere so a person without a
    // display name still reads as themselves rather than as an address.
    label: user.displayName || user.handle || truncateAddress(user.evmAddress),
    bio: user.bio,
    avatarCid: user.avatarCid,
    avatarUrl: user.avatarCid ? gatewayUrl(user.avatarCid) : null,
    // Public on chain already — this is the address every listing shows beside
    // a studio, and it is what makes a profile checkable on HashScan.
    address: user.evmAddress,
    addressShort: truncateAddress(user.evmAddress),
    hederaAccountId: user.hederaAccountId,
    joinedAt: user.createdAt,
    isSelf,
    libraryPublic: user.libraryPublic,
    studios: memberStudios.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      ens: ensFullName(s.ensSubname),
      role: s.role,
    })),
    credits,
    reviews: reviewRows
      .filter((r) => gameById.get(r.gameId)?.status !== "removed")
      .map((r) => ({
        id: r.id,
        rating: r.rating,
        body: r.body,
        createdAt: r.createdAt,
        editedAt: r.editedAt,
        game: gameById.get(r.gameId) ?? null,
      })),
    library,
    stats: {
      gamesCredited: credits.length,
      gamesOwned: showLibrary ? library.length : null,
      reviewCount: reviewRows.length,
      wishlistCount: likeRows.length,
      playCount: sessions.length,
      playtimeSeconds: sessions.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0),
    },
  };
}
