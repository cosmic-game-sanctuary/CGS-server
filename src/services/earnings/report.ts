import { and, eq, inArray, desc } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  games,
  sales,
  splits,
  studios,
  studioMembers,
  pendingPayouts,
  playSessions,
  reviews,
  likes,
} from "../../db/schema.js";
import { assetDecimals, toDisplayAmount } from "../../lib/display.js";
import { env } from "../../config/env.js";

/**
 * What was earned, and what is still owed.
 *
 * One module because the two views have to agree. A studio owner looking at a
 * game and a collaborator looking at the same game must see the same number
 * for the same share, and the only way to guarantee that is for both to be the
 * same arithmetic rather than two queries that happen to match today.
 *
 * **Everything here is derived, never stored.** A running total on a row can
 * drift from the sales that produced it, and there is no way to notice when it
 * has. Recomputing from `sales` and `splits` is cheap at this size and cannot
 * silently disagree with what actually happened.
 *
 * Money keeps its usual shape: integer `*Units` are the truth, the `*Display`
 * float beside it is for rendering and nothing computes with it.
 */

function money(units: number, asset: string) {
  return { units, display: toDisplayAmount(units, asset), assetDecimals: assetDecimals(asset) };
}

/**
 * A person's share of one sale, worked out the same way the payout does.
 *
 * Deliberately mirrors distributeSplits: floor the percentage, then give the
 * rounding remainder to the largest share. If this drifted from that, the
 * dashboard would quietly disagree with the transfers people actually
 * received, which is worse than having no dashboard.
 */
function shareOfSale(priceUnits: number, rows: { id: string; pct: number }[], splitId: string): number {
  const shares = rows.map((r) => ({ id: r.id, amount: Math.floor((priceUnits * r.pct) / 100) }));
  const allocated = shares.reduce((sum, s) => sum + s.amount, 0);
  const remainder = priceUnits - allocated;
  if (remainder > 0 && shares.length > 0) {
    const largest = shares.reduce((a, b) => (b.amount > a.amount ? b : a));
    largest.amount += remainder;
  }
  return shares.find((s) => s.id === splitId)?.amount ?? 0;
}

export type GameEarnings = {
  gameId: string;
  slug: string;
  title: string;
  status: string;
  priceUnits: number;
  studio: { id: string; name: string; slug: string };
  sales: number;
  gross: ReturnType<typeof money>;
  /** Present only on the personal report: this person's cut of that gross. */
  yours?: { pct: number; role: string; earned: ReturnType<typeof money> };
  plays: number;
  likes: number;
  reviews: number;
  rating: number;
};

/**
 * Everything one person has earned, across every studio they are on.
 *
 * Cross-studio on purpose. A person can be credited on games from several
 * teams — that is what inviting a collaborator by email produces — so framing
 * this as "your studio's earnings" would hide money from exactly the people
 * the splits feature exists for.
 */
export async function personalEarnings(userId: string) {
  const memberships = await db.query.studioMembers.findMany({
    where: eq(studioMembers.userId, userId),
    columns: { id: true, studioId: true },
  });
  const memberIds = memberships.map((m) => m.id);

  // A share is theirs if it names them directly, or names a membership row
  // that is theirs. Both, because the wallet is backfilled on accept but the
  // membership link is what existed first.
  const mine = await db.query.splits.findMany({
    where: memberIds.length
      ? inArray(splits.studioMemberId, memberIds)
      : eq(splits.userId, userId),
  });
  const byUser = await db.query.splits.findMany({ where: eq(splits.userId, userId) });
  const all = [...mine, ...byUser.filter((b) => !mine.some((m) => m.id === b.id))];

  if (all.length === 0) {
    return { totals: emptyTotals(), games: [] as GameEarnings[], held: [], failed: [] };
  }

  const gameIds = [...new Set(all.map((s) => s.gameId))];
  const [gameRows, allSplits, saleRows, stats] = await Promise.all([
    db.query.games.findMany({ where: inArray(games.id, gameIds), with: { studio: true } }),
    db.query.splits.findMany({ where: inArray(splits.gameId, gameIds) }),
    db.query.sales.findMany({ where: inArray(sales.gameId, gameIds) }),
    gameStats(gameIds),
  ]);

  const splitsByGame = groupBy(allSplits, (s) => s.gameId);
  const salesByGame = groupBy(saleRows, (s) => s.gameId);

  let earnedUnits = 0;
  let grossUnits = 0;
  let saleCount = 0;
  const asset = env.X402_ASSET;

  const perGame: GameEarnings[] = gameRows.map((game) => {
    const mySplit = all.find((s) => s.gameId === game.id)!;
    const gameSplits = splitsByGame.get(game.id) ?? [];
    const gameSales = salesByGame.get(game.id) ?? [];

    const gross = gameSales.reduce((sum, s) => sum + s.priceUnits, 0);
    const yours = gameSales.reduce(
      (sum, s) => sum + shareOfSale(s.priceUnits, gameSplits, mySplit.id),
      0,
    );

    earnedUnits += yours;
    grossUnits += gross;
    saleCount += gameSales.length;

    const st = stats.get(game.id);
    return {
      gameId: game.id,
      slug: game.slug,
      title: game.title,
      status: game.status,
      priceUnits: game.priceUnits,
      studio: { id: game.studio.id, name: game.studio.name, slug: game.studio.slug },
      sales: gameSales.length,
      gross: money(gross, game.priceAsset),
      yours: { pct: mySplit.pct, role: mySplit.role, earned: money(yours, game.priceAsset) },
      ...(st ?? { plays: 0, likes: 0, reviews: 0, rating: 0 }),
    };
  });

  const { held, failed } = await owedTo(all.map((s) => s.id));

  return {
    totals: {
      earned: money(earnedUnits, asset),
      gross: money(grossUnits, asset),
      sales: saleCount,
      games: perGame.length,
      held: money(held.reduce((sum, h) => sum + h.amountUnits, 0), asset),
      failed: money(failed.reduce((sum, h) => sum + h.amountUnits, 0), asset),
      asset,
    },
    games: perGame.sort((a, b) => (b.yours?.earned.units ?? 0) - (a.yours?.earned.units ?? 0)),
    held,
    failed,
  };
}

/**
 * What a studio earned, and who is still waiting to be paid.
 *
 * Visible to members as well as the owner: they are credited on the games and
 * a team that cannot see its own takings is not a team. Nobody outside sees it.
 */
export async function studioEarnings(studioId: string) {
  const [studio, gameRows] = await Promise.all([
    db.query.studios.findFirst({ where: eq(studios.id, studioId) }),
    db.query.games.findMany({ where: eq(games.studioId, studioId), with: { studio: true } }),
  ]);
  if (!studio) return null;

  const gameIds = gameRows.map((g) => g.id);
  const [allSplits, saleRows, stats] = await Promise.all([
    gameIds.length ? db.query.splits.findMany({ where: inArray(splits.gameId, gameIds) }) : [],
    gameIds.length ? db.query.sales.findMany({ where: inArray(sales.gameId, gameIds) }) : [],
    gameStats(gameIds),
  ]);

  const splitsByGame = groupBy(allSplits, (s) => s.gameId);
  const salesByGame = groupBy(saleRows, (s) => s.gameId);
  const asset = env.X402_ASSET;

  let grossUnits = 0;
  let saleCount = 0;

  const perGame: GameEarnings[] = gameRows.map((game) => {
    const gameSales = salesByGame.get(game.id) ?? [];
    const gross = gameSales.reduce((sum, s) => sum + s.priceUnits, 0);
    grossUnits += gross;
    saleCount += gameSales.length;

    const st = stats.get(game.id);
    return {
      gameId: game.id,
      slug: game.slug,
      title: game.title,
      status: game.status,
      priceUnits: game.priceUnits,
      studio: { id: studio.id, name: studio.name, slug: studio.slug },
      sales: gameSales.length,
      gross: money(gross, game.priceAsset),
      ...(st ?? { plays: 0, likes: 0, reviews: 0, rating: 0 }),
    };
  });

  // Who earned what, across the whole studio. Keyed by handle because that is
  // the identity on a split and the only one a collaborator without an account
  // has at all.
  const people = new Map<string, { handle: string; role: string; earnedUnits: number; games: number; claimed: boolean }>();
  for (const game of gameRows) {
    const gameSplits = splitsByGame.get(game.id) ?? [];
    const gameSales = salesByGame.get(game.id) ?? [];
    for (const split of gameSplits) {
      const earned = gameSales.reduce((sum, s) => sum + shareOfSale(s.priceUnits, gameSplits, split.id), 0);
      const cur = people.get(split.handle) ?? {
        handle: split.handle, role: split.role, earnedUnits: 0, games: 0,
        claimed: split.wallet !== null,
      };
      cur.earnedUnits += earned;
      cur.games += 1;
      cur.claimed = cur.claimed || split.wallet !== null;
      people.set(split.handle, cur);
    }
  }

  const { held, failed } = await owedTo(allSplits.map((s) => s.id));

  return {
    studio: { id: studio.id, name: studio.name, slug: studio.slug },
    totals: {
      gross: money(grossUnits, asset),
      sales: saleCount,
      games: gameRows.length,
      published: gameRows.filter((g) => g.status === "published").length,
      held: money(held.reduce((sum, h) => sum + h.amountUnits, 0), asset),
      failed: money(failed.reduce((sum, h) => sum + h.amountUnits, 0), asset),
      asset,
    },
    games: perGame.sort((a, b) => b.gross.units - a.gross.units),
    people: [...people.values()]
      .map((p) => ({ ...p, earned: money(p.earnedUnits, asset) }))
      .sort((a, b) => b.earnedUnits - a.earnedUnits),
    held,
    failed,
  };
}

/** Held and failed payouts against a set of splits, with enough to explain them. */
async function owedTo(splitIds: string[]) {
  if (splitIds.length === 0) return { held: [], failed: [] };

  const rows = await db.query.pendingPayouts.findMany({
    where: and(inArray(pendingPayouts.splitId, splitIds), inArray(pendingPayouts.status, ["held", "failed"])),
    orderBy: desc(pendingPayouts.createdAt),
  });
  if (rows.length === 0) return { held: [], failed: [] };

  const gameRows = await db.query.games.findMany({
    where: inArray(games.id, [...new Set(rows.map((r) => r.gameId))]),
    columns: { id: true, title: true, slug: true },
  });
  const titleById = new Map(gameRows.map((g) => [g.id, g]));

  const shaped = rows.map((r) => ({
    id: r.id,
    gameId: r.gameId,
    gameTitle: titleById.get(r.gameId)?.title ?? null,
    gameSlug: titleById.get(r.gameId)?.slug ?? null,
    amount: money(r.amountUnits, r.asset),
    amountUnits: r.amountUnits,
    asset: r.asset,
    reason: r.reason,
    since: r.createdAt,
    status: r.status,
  }));

  return {
    held: shaped.filter((r) => r.status === "held"),
    failed: shaped.filter((r) => r.status === "failed"),
  };
}

/** Plays, likes, reviews and rating per game. Batched, same as the catalog. */
async function gameStats(gameIds: string[]) {
  const out = new Map<string, { plays: number; likes: number; reviews: number; rating: number }>();
  if (gameIds.length === 0) return out;

  const [sessionRows, likeRows, reviewRows] = await Promise.all([
    db.query.playSessions.findMany({ where: inArray(playSessions.gameId, gameIds), columns: { gameId: true } }),
    db.query.likes.findMany({ where: inArray(likes.gameId, gameIds), columns: { gameId: true } }),
    db.query.reviews.findMany({ where: inArray(reviews.gameId, gameIds), columns: { gameId: true, rating: true } }),
  ]);

  for (const id of gameIds) out.set(id, { plays: 0, likes: 0, reviews: 0, rating: 0 });
  for (const r of sessionRows) out.get(r.gameId)!.plays += 1;
  for (const r of likeRows) out.get(r.gameId)!.likes += 1;

  const ratings = groupBy(reviewRows, (r) => r.gameId);
  for (const [gameId, rows] of ratings) {
    const stat = out.get(gameId)!;
    stat.reviews = rows.length;
    stat.rating = rows.reduce((sum, r) => sum + r.rating, 0) / rows.length;
  }
  return out;
}

function emptyTotals() {
  const asset = env.X402_ASSET;
  return {
    earned: money(0, asset), gross: money(0, asset), sales: 0, games: 0,
    held: money(0, asset), failed: money(0, asset), asset,
  };
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    out.set(k, [...(out.get(k) ?? []), row]);
  }
  return out;
}
