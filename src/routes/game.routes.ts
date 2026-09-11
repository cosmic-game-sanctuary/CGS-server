import { Router, type Request } from "express";
import { and, desc, asc, eq, or, ilike, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import multer from "multer";
import { db } from "../db/client.js";
import {
  games,
  studios,
  studioMembers,
  splits,
  reviews,
  gameMedia,
  notifications,
  users,
  playSessions,
  wishlistItems,
  wishlistAgents,
  comments,
  gameBuilds,
} from "../db/schema.js";
import { truncateAddress } from "../lib/address.js";
import { requireAuth, optionalAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError, Errors } from "../lib/errors.js";
import { slugify, withSuffix } from "../lib/slug.js";
import { ownsGame } from "../services/games/ownership.js";
import { hasEntitlement } from "../services/games/entitlement.js";
import { grantAccess, buildPathFor } from "../services/games/download.js";
import { findBuild } from "../services/games/buildStore.js";
import { env } from "../config/env.js";
import { param, isUuid } from "../lib/params.js";
import { assetDecimals, ensFullName, toDisplayAmount } from "../lib/display.js";
import { authorSummaries, type AuthorSummary } from "../services/users/profile.js";
import { findGameByRef } from "../services/games/lookup.js";
import { activePromotionFor, serializePromotion } from "../services/games/promotions.js";
import {
  listSaves,
  readSave,
  writeSave,
  deleteSave,
  MAX_SLOTS,
  MAX_SAVE_BYTES,
} from "../services/games/saves.js";
import {
  addToWishlist,
  removeFromWishlist,
  wishlistCount,
  announceDemandIfMilestone,
} from "../services/games/wishlist.js";
import { agentBalance } from "../services/agent/wallet.js";
import logger from "../utils/logger.utils.js";
import { pinFile, gatewayUrl } from "../services/ipfs/pinata.js";
import { ingestBuild, commitBuild } from "../services/games/builds.js";
import { announce } from "../services/games/listing.js";
import {
  resourceServer,
  ensureInitialized,
  readPaymentHeader,
  decodePaymentPayload,
} from "../services/x402/server.js";
import { fulfilPurchase } from "../services/games/fulfil.js";
import { getAccountByEvmAddress } from "../services/hedera/mirror.js";
import { preparePayment, completePayment, prepareTrialChunk, completeTrialChunk } from "../services/x402/pay.js";
import { emailStudioInvite } from "../services/email/messages.js";
import { createGameToken } from "../services/hedera/hts.js";
import { resolveHederaAccount } from "../services/users/repo.js";
import {
  trialEnabled,
  trialStatusFor,
  resolvePurchasePrice,
  trialChunksFor,
} from "../services/games/trials.js";

const gameRouter = Router({ caseSensitive: true, strict: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// ratings are averaged in JS rather than in SQL — the catalog is a few dozen
// rows at hackathon scale, and this avoids depending on drizzle's aggregate
// builders for something this small.
async function ratingsFor(gameIds: string[]) {
  if (gameIds.length === 0) return new Map<string, { rating: number; reviewCount: number }>();
  const rows = await db.query.reviews.findMany({
    where: inArray(reviews.gameId, gameIds),
    columns: { gameId: true, rating: true },
  });
  const byGame = new Map<string, number[]>();
  for (const r of rows) byGame.set(r.gameId, [...(byGame.get(r.gameId) ?? []), r.rating]);

  const out = new Map<string, { rating: number; reviewCount: number }>();
  for (const [gameId, ratings] of byGame) {
    out.set(gameId, {
      rating: ratings.reduce((a, b) => a + b, 0) / ratings.length,
      reviewCount: ratings.length,
    });
  }
  return out;
}

// Same shape and same reasoning as ratingsFor above: a JS count over a
// batched fetch, not a SQL aggregate, because this catalog is a few dozen
// rows and a handful of sessions/likes each, not a scale where that matters.
async function playsFor(gameIds: string[]) {
  if (gameIds.length === 0) return new Map<string, number>();
  const rows = await db.query.playSessions.findMany({
    where: inArray(playSessions.gameId, gameIds),
    columns: { gameId: true },
  });
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.gameId, (out.get(r.gameId) ?? 0) + 1);
  return out;
}

// Highest rated first, unrated last — an unreviewed game sorting above a 4.8
// because both "score" zero would make the chip useless. Ties break on recency,
// matching the default sort.
async function sortByRating<T extends { id: string; publishedAt: Date | null }>(rows: T[]): Promise<T[]> {
  const ratings = await ratingsFor(rows.map((r) => r.id));
  return [...rows].sort((a, b) => {
    const ra = ratings.get(a.id)?.rating ?? -1;
    const rb = ratings.get(b.id)?.rating ?? -1;
    if (rb !== ra) return rb - ra;
    return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
  });
}

// Member count and owner address for a set of studios, in two queries rather
// than two per game. Same batching reasoning as ratingsFor.
async function studioExtrasFor(studioIds: string[]) {
  const out = new Map<string, { memberCount: number; ownerAddress: string | null }>();
  if (studioIds.length === 0) return out;

  const rows = await db.query.studios.findMany({
    where: inArray(studios.id, studioIds),
    columns: { id: true, ownerUserId: true },
  });

  const [members, owners] = await Promise.all([
    // Active only — same roster the studio page itself now shows. Someone who
    // left keeps every credit on `splits`, they just stop counting as "on the
    // team" here.
    db.query.studioMembers.findMany({
      where: and(inArray(studioMembers.studioId, studioIds), eq(studioMembers.active, true)),
      columns: { studioId: true },
    }),
    db.query.users.findMany({
      where: inArray(users.id, [...new Set(rows.map((r) => r.ownerUserId))]),
      columns: { id: true, evmAddress: true },
    }),
  ]);

  const addressByUser = new Map(owners.map((o) => [o.id, o.evmAddress]));
  const counts = new Map<string, number>();
  for (const m of members) counts.set(m.studioId, (counts.get(m.studioId) ?? 0) + 1);

  for (const r of rows) {
    out.set(r.id, {
      memberCount: counts.get(r.id) ?? 0,
      ownerAddress: addressByUser.get(r.ownerUserId) ?? null,
    });
  }
  return out;
}

// The profile behind each split line, so a credit is a link rather than a bare
// word. A share names its person either directly (`userId`) or through the
// studio membership that was created for them by email — the second is the
// whole point of the invite flow, so resolving only the first would leave
// exactly the collaborators this product exists to credit uncredited.
async function creditProfilesFor(splitRows: (typeof splits.$inferSelect)[]) {
  const out = new Map<string, AuthorSummary | null>();
  if (splitRows.length === 0) return out;

  const memberIds = splitRows
    .filter((s) => !s.userId && s.studioMemberId)
    .map((s) => s.studioMemberId!);
  const members = memberIds.length
    ? await db.query.studioMembers.findMany({
        where: inArray(studioMembers.id, [...new Set(memberIds)]),
        columns: { id: true, userId: true },
      })
    : [];
  const userIdByMember = new Map(members.map((m) => [m.id, m.userId]));

  // The third way a share names someone: a bare wallet, which is what the
  // publish form writes when a developer credits themselves by address. That
  // is the most common split on the site and it was the one that resolved to
  // nobody, so a game's own author showed up uncredited on their own page.
  const wallets = splitRows
    .filter((s) => !s.userId && !s.studioMemberId && s.wallet)
    .map((s) => s.wallet!);
  const byWallet = new Map<string, string>();
  if (wallets.length > 0) {
    const evm = [...new Set(wallets.filter((w) => w.startsWith("0x")).map((w) => w.toLowerCase()))];
    const accounts = [...new Set(wallets.filter((w) => /^\d+\.\d+\.\d+$/.test(w)))];
    const matches = await db.query.users.findMany({
      where: or(
        // Case-insensitive: Privy hands back a checksummed address and a
        // person pasting one rarely preserves the capitalisation.
        evm.length ? sql`lower(${users.evmAddress}) IN ${evm}` : undefined,
        accounts.length ? inArray(users.hederaAccountId, accounts) : undefined,
      ),
      columns: { id: true, evmAddress: true, hederaAccountId: true },
    });
    for (const m of matches) {
      byWallet.set(m.evmAddress.toLowerCase(), m.id);
      if (m.hederaAccountId) byWallet.set(m.hederaAccountId, m.id);
    }
  }

  const userIds = [
    ...splitRows.map((s) => s.userId),
    ...members.map((m) => m.userId),
    ...byWallet.values(),
  ].filter((id): id is string => id !== null);
  const summaries = await authorSummaries(userIds);

  // Three ways in, tried in order of how certain each one is.
  for (const row of splitRows) {
    let userId: string | null = row.userId;
    if (!userId && row.studioMemberId) userId = userIdByMember.get(row.studioMemberId) ?? null;
    if (!userId && row.wallet) {
      userId = byWallet.get(row.wallet.toLowerCase()) ?? byWallet.get(row.wallet) ?? null;
    }
    out.set(row.id, userId ? (summaries.get(userId) ?? null) : null);
  }
  return out;
}

async function likeCountsFor(gameIds: string[]) {
  if (gameIds.length === 0) return new Map<string, number>();
  const rows = await db.query.wishlistItems.findMany({
    where: inArray(wishlistItems.gameId, gameIds),
    columns: { gameId: true },
  });
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.gameId, (out.get(r.gameId) ?? 0) + 1);
  return out;
}

const catalogQuerySchema = z.object({
  search: z.string().max(200).optional(),
  tag: z.string().max(40).optional(),
  // the studio page shows full cards, and the studio route returns only
  // enough of each game to identify one. Filtering here is cheaper than a
  // detail read per game, and it excludes drafts for free.
  studioId: z.string().uuid().optional(),
  sort: z.enum(["newest", "price-low", "price-high", "rating"]).default("newest"),
  freeOnly: z.coerce.boolean().optional(),
  cursor: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(60).default(24),
});

gameRouter.get(
  "/",
  optionalAuth,
  validate(catalogQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const { search, tag, studioId, sort, freeOnly, cursor, limit } =
      req.query as unknown as z.infer<typeof catalogQuerySchema>;

    // Searching only `title` missed the obvious cases — a genre typed into the
    // box, or a studio's name. Tagline and tags are what people actually
    // remember a small game by.
    const needle = search?.trim();
    const where = and(
      eq(games.status, "published"),
      needle
        ? or(
            ilike(games.title, `%${needle}%`),
            ilike(games.tagline, `%${needle}%`),
            sql`EXISTS (SELECT 1 FROM unnest(${games.tags}) AS t WHERE t ILIKE ${`%${needle}%`})`,
            sql`EXISTS (SELECT 1 FROM studios s WHERE s.id = ${games.studioId} AND (s.name ILIKE ${`%${needle}%`} OR s.ens_subname ILIKE ${`%${needle}%`}))`,
          )
        : undefined,
      tag ? sql`${games.tags} @> ARRAY[${tag}]::text[]` : undefined,
      studioId ? eq(games.studioId, studioId) : undefined,
      freeOnly ? eq(games.priceUnits, 0) : undefined,
    );

    const orderBy =
      sort === "price-low"
        ? asc(games.priceUnits)
        : sort === "price-high"
          ? desc(games.priceUnits)
          : desc(games.publishedAt);

    // "rating" is the one sort whose key isn't a column — it's an average over
    // the reviews table. Rather than leave it silently sorting by date (which
    // it did, and which reads on screen as a filter that does nothing), fetch
    // the matching set, order it by the rating we already compute, then page.
    // Honest at this catalog's size and it stops the chip being a lie; revisit
    // with a real aggregate query if the catalog ever gets large.
    const byRating = sort === "rating";
    const rows = await db.query.games.findMany({
      where,
      orderBy,
      ...(byRating ? {} : { limit: limit + 1, offset: cursor }),
      with: { studio: true },
    });

    const ranked = byRating ? await sortByRating(rows) : rows;
    const window = byRating ? ranked.slice(cursor, cursor + limit + 1) : ranked;

    const hasMore = window.length > limit;
    const page = hasMore ? window.slice(0, limit) : window;
    const ids = page.map((g) => g.id);

    const [ratings, splitRows, plays, likeCounts, studioExtras] = await Promise.all([
      ratingsFor(ids),
      db.query.splits.findMany({ where: inArray(splits.gameId, ids) }),
      playsFor(ids),
      likeCountsFor(ids),
      studioExtrasFor([...new Set(page.map((g) => g.studioId))]),
    ]);
    const splitsByGame = new Map<string, typeof splitRows>();
    for (const s of splitRows) splitsByGame.set(s.gameId, [...(splitsByGame.get(s.gameId) ?? []), s]);
    const credits = await creditProfilesFor(splitRows);

    res.json({
      games: page.map((g) =>
        serializeGame(
          g,
          splitsByGame.get(g.id) ?? [],
          ratings.get(g.id),
          plays.get(g.id),
          likeCounts.get(g.id),
          studioExtras.get(g.studioId),
          credits,
        ),
      ),
      nextCursor: hasMore ? String(cursor + limit) : null,
    });
  }),
);

gameRouter.get(
  "/:idOrSlug",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const idOrSlug = param(req, "idOrSlug");
    const game = await db.query.games.findFirst({
      where: isUuid(idOrSlug) ? or(eq(games.id, idOrSlug), eq(games.slug, idOrSlug)) : eq(games.slug, idOrSlug),
      with: { studio: true },
    });
    if (!game) throw Errors.notFound("Game");

    const [gameSplits, media, ratings, plays, likeCounts, studioExtras] = await Promise.all([
      db.query.splits.findMany({ where: eq(splits.gameId, game.id) }),
      db.query.gameMedia.findMany({ where: eq(gameMedia.gameId, game.id), orderBy: asc(gameMedia.position) }),
      ratingsFor([game.id]),
      playsFor([game.id]),
      likeCountsFor([game.id]),
      studioExtrasFor([game.studioId]),
    ]);

    const activeSale = await activePromotionFor(game.id);

    let owned: boolean | undefined;
    let liked: boolean | undefined;
    // The want on that same row, when there is one. The lookup was already
    // happening and was throwing everything but a boolean away, which left a
    // client with no way to render "your agent buys this at X" without
    // fetching the whole wishlist to find one row.
    let agentMaxUnits: number | null = null;
    let agentNote: string | null = null;
    if (req.auth) {
      owned = (await ownsGame(req.auth.evmAddress, game.htsTokenId)).owned;
      const saved = await db.query.wishlistItems.findFirst({
        where: and(eq(wishlistItems.gameId, game.id), eq(wishlistItems.userId, req.auth.id)),
      });
      liked = !!saved;
      agentMaxUnits = saved?.agentMaxUnits ?? null;
      agentNote = saved?.agentNote ?? null;
    }

    res.json({
      ...serializeGame(
        game,
        gameSplits,
        ratings.get(game.id),
        plays.get(game.id),
        likeCounts.get(game.id),
        studioExtras.get(game.studioId),
        await creditProfilesFor(gameSplits),
      ),
      // the client shows screenshots from a gateway URL, so send the CID it
      // needs rather than making it know how we address IPFS.
      media: media.map((m) => ({ id: m.id, kind: m.kind, cid: m.cid, position: m.position, url: gatewayUrl(m.cid) })),
      owned,
      liked,
      // The same value under the name the list actually has now.
      wishlisted: liked,
      // The ceiling this person's agent will buy at, and their note to it.
      // Null for a plain saved game, and for anyone signed out.
      agentMaxUnits,
      agentNote,
      // The sale this price came from, when it came from one. `endsAt` is the
      // part worth rendering — a discount with a visible deadline is a
      // different thing from a cheap game.
      promotion: activeSale ? serializePromotion(activeSale) : null,
    });
  }),
);

/** Extra facts about a studio the listing shows but the row doesn't carry. */
type StudioExtras = { memberCount?: number; ownerAddress?: string | null };

function serializeGame(
  game: typeof games.$inferSelect & { studio: typeof studios.$inferSelect },
  gameSplits: (typeof splits.$inferSelect)[],
  rating?: { rating: number; reviewCount: number },
  plays?: number,
  likeCount?: number,
  studioExtras?: StudioExtras,
  credits?: Map<string, AuthorSummary | null>,
) {
  return {
    id: game.id,
    slug: game.slug,
    title: game.title,
    tagline: game.tagline,
    description: game.description,
    studio: {
      id: game.studio.id,
      name: game.studio.name,
      ens: ensFullName(game.studio.ensSubname),
      slug: game.studio.slug,
      bio: game.studio.bio,
      // "3 people" under the studio link, and the truncated address beside
      // it — both shown on every listing, neither on the studios row itself.
      memberCount: studioExtras?.memberCount ?? 0,
      ownerAddress: studioExtras?.ownerAddress ?? null,
    },
    priceUnits: game.priceUnits,
    priceAsset: game.priceAsset,
    priceUsd: toDisplayAmount(game.priceUnits, game.priceAsset),
    priceAssetDecimals: assetDecimals(game.priceAsset),
    tags: game.tags,
    coverCid: game.coverCid,
    coverUrl: game.coverCid ? gatewayUrl(game.coverCid) : null,
    coverSeed: game.coverSeed,
    publishedAt: game.publishedAt,
    // The listing's own state, which nothing outside the studio page could see
    // before. A client rendering a game it may be allowed to manage needs to
    // know whether it is a draft, live, or unlisted — and `updatedAt` is what a
    // "recently updated" shelf sorts on.
    status: game.status,
    updatedAt: game.updatedAt,
    buildVersion: game.buildVersion,
    delistedBy: game.delistedBy,
    // `handle` is the name on this game's credits, which is per-game on
    // purpose — someone can be "kai (art)" here and something else elsewhere.
    // `profile` is the person behind it, and null when they have never signed
    // in: an invited collaborator is credited and paid from the first sale
    // whether or not they ever open the site.
    splits: gameSplits.map((s) => ({
      handle: s.handle,
      role: s.role,
      pct: s.pct,
      profile: credits?.get(s.id) ?? null,
    })),
    rating: rating?.rating ?? 0,
    reviewCount: rating?.reviewCount ?? 0,
    // a real count at last, batched the same way rating is above — the
    // contract has promised this field since Stage 1 and nothing ever
    // incremented it. See playSessions in db/schema.ts.
    plays: plays ?? 0,
    likeCount: likeCount ?? 0,
    wishlistCount: likeCount ?? 0,
    buildKb: game.buildSizeKb,
  };
}

// --- publish pipeline -------------------------------------------------
// Stage 1/2 boundary: metadata, splits and the draft row are real today.
// File pinning, the CSAM gate, and HTS token creation are Stage 2 and throw
// NOT_IMPLEMENTED below rather than pretending to succeed.

// A share names a person one of three ways, and only the first requires them
// to have ever opened CGS:
//
//   wallet         — an address or 0.0.x. You, or anyone who has signed in.
//   studioMemberId — someone already on the studio, picked from the roster.
//   email          — someone new. The row is created here and the invite is
//                    that row; their share is held until they claim it.
//
// Requiring a wallet was the single thing stopping the splits editor from
// doing what it exists for. See services/games/fulfil.ts#distributeSplits.
const splitSchema = z
  .object({
    wallet: z.string().min(1).optional(),
    studioMemberId: z.string().uuid().optional(),
    email: z.string().email().optional(),
    handle: z.string().min(1).max(40),
    role: z.string().min(1).max(40),
    pct: z.number().int().min(1).max(100),
  })
  .refine((s) => s.wallet || s.studioMemberId || s.email, {
    message: "each split needs a wallet, a studioMemberId, or an email",
  });

const publishGameSchema = z.object({
  studioId: z.string().uuid(),
  title: z.string().min(1).max(120),
  tagline: z.string().max(200).default(""),
  description: z.string().max(5000).default(""),
  // multipart has no array type: multer gives repeated fields as an array but
  // a single one as a bare string, so a game with exactly one tag would fail
  // validation while two passed. Normalise before parsing.
  tags: z
    .preprocess(
      (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]),
      z.array(z.string().max(40)).max(10),
    )
    .default([]),
  priceUnits: z.coerce.number().int().nonnegative(),
  priceAsset: z.string().default(env.X402_ASSET),
  coverMediaIndex: z.coerce.number().int().nonnegative().optional(),
  // What the developer calls this first build — "v18", "1.0". Optional, and
  // free text: a version number we invented would not be the one in their notes.
  buildLabel: z.string().max(40).optional(),
  splits: z
    .string()
    .transform((s, ctx) => {
      try {
        return z.array(splitSchema).parse(JSON.parse(s));
      } catch {
        ctx.addIssue({ code: "custom", message: "splits must be a JSON array" });
        return z.NEVER;
      }
    }),
});

type SplitInput = z.infer<typeof splitSchema>;
type ResolvedSplit = {
  wallet: string | null;
  studioMemberId: string | null;
  userId: string | null;
  handle: string;
  role: string;
  pct: number;
  /** Set when this call created the membership, so the caller can show a link. */
  invited?: { id: string; email: string; handle: string };
};

/**
 * Turn what the splits editor sends into rows that can be paid.
 *
 * The wallet is looked up rather than trusted from the client wherever we can
 * know it: a member who has accepted has a user, and that user has an address.
 * A member who hasn't gets `wallet: null`, which is what makes their share
 * held rather than unpublishable.
 */
async function resolveSplitRecipients(
  studioId: string,
  inputs: SplitInput[],
): Promise<ResolvedSplit[]> {
  const out: ResolvedSplit[] = [];

  for (const input of inputs) {
    const base = { handle: input.handle, role: input.role, pct: input.pct };

    // An explicit wallet wins: it's you, or someone whose address is known.
    if (input.wallet) {
      out.push({ ...base, wallet: input.wallet, studioMemberId: null, userId: null });
      continue;
    }

    const found = input.studioMemberId
      ? await db.query.studioMembers.findFirst({
          where: and(eq(studioMembers.id, input.studioMemberId), eq(studioMembers.studioId, studioId)),
        })
      : undefined;
    const member = found
      ? { ...found, createdHere: false }
      : input.email
        ? await findOrInviteMember(studioId, input.email, input.handle)
        : undefined;

    if (!member) {
      throw Errors.validationFailed({ splits: `no such member on this studio: ${input.handle}` });
    }

    // Accepted already? Then their address is known and the share can pay out
    // on the first sale like anyone else's.
    const user = member.userId
      ? await db.query.users.findFirst({ where: eq(users.id, member.userId) })
      : null;

    out.push({
      ...base,
      wallet: user?.evmAddress ?? null,
      studioMemberId: member.id,
      userId: member.userId,
      invited: member.createdHere ? { id: member.id, email: member.email, handle: member.handle } : undefined,
    });
  }

  return out;
}

/** Matching on email, so publishing twice with the same teammate reuses the invite. */
async function findOrInviteMember(studioId: string, email: string, handle: string) {
  const existing = await db.query.studioMembers.findFirst({
    where: and(eq(studioMembers.studioId, studioId), eq(studioMembers.email, email)),
  });
  if (existing) {
    // Someone who left or was removed and is now being credited on a new game
    // is being brought back onto the team, not just quietly named on a split
    // while still showing as inactive everywhere else. Treated as a fresh
    // invite (`createdHere: true`) so the usual "you've been added" email
    // still goes out — being put back on the roster deserves the same
    // notice as being put on it the first time.
    if (!existing.active) {
      const [reactivated] = await db
        .update(studioMembers)
        .set({ active: true })
        .where(eq(studioMembers.id, existing.id))
        .returning();
      return { ...reactivated!, createdHere: true };
    }
    return { ...existing, createdHere: false };
  }

  const [created] = await db
    .insert(studioMembers)
    .values({ studioId, email, handle, role: "member" })
    .returning();
  return { ...created!, createdHere: true };
}

gameRouter.post(
  "/",
  requireAuth,
  upload.fields([{ name: "build", maxCount: 1 }, { name: "media", maxCount: 8 }]),
  validate(publishGameSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof publishGameSchema>;
    const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;

    const studio = await db.query.studios.findFirst({ where: eq(studios.id, body.studioId) });
    if (!studio) throw Errors.notFound("Studio");
    if (studio.ownerUserId !== req.auth!.id) throw Errors.notOwner();

    const totalPct = body.splits.reduce((sum, s) => sum + s.pct, 0);
    if (totalPct !== 100) {
      throw Errors.validationFailed({ splits: `must total 100, got ${totalPct}` });
    }
    if (!files?.build?.[0]) {
      throw Errors.validationFailed({ build: "a build file is required" });
    }
    const mediaFiles = files.media ?? [];
    if (body.coverMediaIndex !== undefined && !mediaFiles[body.coverMediaIndex]) {
      throw Errors.validationFailed({ coverMediaIndex: "out of range for the uploaded media" });
    }

    let slug = slugify(body.title);
    if (await db.query.games.findFirst({ where: eq(games.slug, slug) })) slug = withSuffix(slug);

    // Unpack, moderate, pin — one function, and the same one every later build
    // version goes through (services/games/builds.ts). It fails closed: nothing
    // is pinned and nothing is inserted until the check passes, and the
    // screenshots go through that same single check, which is why they are
    // handed in here rather than checked separately afterwards.
    const artifacts = await ingestBuild(
      files.build[0]!.buffer,
      slug,
      mediaFiles.map((f) => f.buffer),
    );

    const mediaCids = await Promise.all(
      mediaFiles.map((f) => pinFile(f.buffer, f.originalname, f.mimetype)),
    );
    const coverCid = body.coverMediaIndex !== undefined ? mediaCids[body.coverMediaIndex] : undefined;

    const [game] = await db
      .insert(games)
      .values({
        studioId: studio.id,
        slug,
        title: body.title,
        tagline: body.tagline,
        description: body.description,
        tags: body.tags,
        coverCid,
        coverSeed: Math.floor(Math.random() * 1_000_000),
        buildCid: artifacts.buildCid,
        buildZipCid: artifacts.buildZipCid,
        buildSizeKb: artifacts.buildSizeKb,
        priceUnits: body.priceUnits,
        priceAsset: body.priceAsset,
        status: "draft",
      })
      .returning();

    // Version 1, recorded the same way version 2 will be: a row in the build
    // history, the mirror of it on `games`, and the zip kept where it can
    // actually be served. See services/games/builds.ts.
    await commitBuild(game!.id, artifacts, { label: body.buildLabel });

    // Resolve each share to whoever it belongs to, creating the studio
    // membership for anyone named only by email. That row *is* the invite —
    // /invite/:id takes a studio_members id — so publishing with a teammate
    // added by email is what sends them one, with no separate call.
    const resolved = await resolveSplitRecipients(studio.id, body.splits);

    // Someone named only by email now has a membership row, and that row is
    // the invite. Telling them is the half that was missing: the share is
    // theirs from the first sale whether or not they ever accept, so the
    // message is a fact rather than a request.
    for (const share of resolved) {
      if (!share.invited) continue;
      void emailStudioInvite({
        to: share.invited.email,
        handle: share.invited.handle,
        studioName: studio.name,
        inviteId: share.invited.id,
        gameTitle: body.title,
        pct: share.pct,
      });
    }

    await db.insert(splits).values(
      resolved.map((s) => ({
        gameId: game!.id,
        wallet: s.wallet,
        studioMemberId: s.studioMemberId,
        userId: s.userId,
        handle: s.handle,
        role: s.role,
        pct: s.pct,
      })),
    );

    if (mediaCids.length > 0) {
      await db.insert(gameMedia).values(
        mediaCids.map((cid, i) => ({
          gameId: game!.id,
          kind: (mediaFiles[i]!.mimetype.startsWith("video/") ? "video" : "image") as "video" | "image",
          cid,
          position: i,
        })),
      );
    }

    // The invites created by this upload come back with the draft, because
    // there is no mail server here and the publish screen has to be able to
    // show what each person would have received.
    const invited = resolved.map((s) => s.invited).filter((i) => i !== undefined);

    res.status(201).json({ ...game, invited });
  }),
);

gameRouter.post(
  "/:id/publish",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");

    const studio = await db.query.studios.findFirst({ where: eq(studios.id, game.studioId) });
    if (studio!.ownerUserId !== req.auth!.id) throw Errors.notOwner();
    if (game.status !== "draft") throw Errors.validationFailed({ status: "only a draft can be published" });

    const gameSplits = await db.query.splits.findMany({ where: eq(splits.gameId, game.id) });
    const totalPct = gameSplits.reduce((sum, s) => sum + s.pct, 0);
    if (totalPct !== 100) throw Errors.splitsLocked(`splits total ${totalPct}, not 100 — this shouldn't happen`);

    const symbol = game.slug.replace(/-/g, "").slice(0, 5).toUpperCase();
    const tokenId = await createGameToken(game.title, symbol);

    const [published] = await db
      .update(games)
      .set({ status: "published", publishedAt: new Date(), htsTokenId: tokenId })
      .where(eq(games.id, game.id))
      .returning();

    // The listing *is* this message — see services/games/listing.ts. Sent
    // through the same helper every later change uses, so a publish and a price
    // change put the same shape on the topic.
    const hcsTxId = await announce(published!, "listed");
    if (hcsTxId) {
      await db
        .update(gameBuilds)
        .set({ hcsTxId })
        .where(and(eq(gameBuilds.gameId, game.id), eq(gameBuilds.version, published!.buildVersion)));
    }

    const members = await db.query.studioMembers.findMany({
      where: and(eq(studioMembers.studioId, game.studioId), isNotNull(studioMembers.userId)),
    });
    if (members.length > 0) {
      await db.insert(notifications).values(
        members.map((m) => ({
          userId: m.userId!,
          type: "published" as const,
          // slug included so a row can link at the listing. Every payload
          // carries what its row needs to render and where it points; the
          // wording itself belongs to the client.
          payload: { gameId: game.id, slug: game.slug, title: game.title },
        })),
      );
    }

    res.json(published);
  }),
);

// The x402-gated route — the one endpoint here that isn't ordinary REST.
//
// Three branches, in this order:
//   1. free game            -> serve, still mint a GameKey
//   2. caller already owns  -> serve, no second charge (checked against the
//                              Mirror Node, not our cache). Without this a
//                              buyer pays again on every page refresh.
//   3. otherwise            -> 402 + PaymentRequirements, then verify + settle
//                              through Blocky402 on the retry.
//
// A delisted game still serves to branch 2 — delisting removes a game from the
// catalog, it does not revoke anyone's copy. Only `removed` (illegal content,
// unpinned from storage) actually ends access.
gameRouter.get(
  "/:id/download",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");

    // Free, or already bought. Both answered in services/games/download.ts,
    // because the payment path has to ask the same question before it starts
    // building a transfer nobody owes.
    const granted = await grantAccess(game, req.auth);
    if (granted) {
      res.json(granted);
      return;
    }

    // Nothing to charge for, so the only thing standing between this caller and
    // the game is an account to mint the key to. Say that, rather than offering
    // payment terms for zero.
    if (game.priceUnits === 0) throw Errors.unauthenticated("Sign in to get this game.");

    // Trial credit — every chunk this caller has already paid for on this
    // game — reduces what's actually owed. Recomputed fresh on every request
    // to this route rather than cached anywhere, the same way the price
    // itself always is: this handler runs once to issue the 402 and again to
    // settle the retry, and both runs need to agree. See
    // services/games/trials.ts#resolvePurchasePrice for the arithmetic.
    const creditAccountId = req.auth ? await resolveHederaAccount(req.auth) : null;
    const { owedUnits, creditUnits } = await resolvePurchasePrice(game, creditAccountId);

    // Credit alone covers the whole price. Below the relay's one-tinybar
    // floor a zero-amount x402 challenge would just fail confusingly, so this
    // routes through the same "nothing to charge" shape a free game uses,
    // rather than ever offering payment terms for zero.
    if (owedUnits === 0 && creditAccountId) {
      await fulfilPurchase(
        game,
        creditAccountId,
        `trial-credit:${game.id}:${creditAccountId}`,
        0,
        "purchase",
        game.priceUnits,
      );
      res.json({
        buildPath: buildPathFor(game),
        buildCid: game.buildCid,
        tokenId: game.htsTokenId,
        keyStatus: "pending",
      });
      return;
    }

    await ensureInitialized();

    const requirements = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: env.X402_NETWORK,
      payTo: env.X402_PAY_TO,
      price: { asset: game.priceAsset, amount: String(owedUnits) },
      maxTimeoutSeconds: 180,
    });

    const resourceInfo = {
      url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
      description: `${game.title} — game build`,
      mimeType: "application/json",
    };

    const header = readPaymentHeader(req.headers as Record<string, unknown>);
    if (!header) {
      const paymentRequired = await resourceServer.createPaymentRequiredResponse(
        requirements,
        resourceInfo,
      );
      res.status(402).json(paymentRequired);
      return;
    }

    const payload = decodePaymentPayload(header);
    const matched = resourceServer.findMatchingRequirements(requirements, payload);
    if (!matched) {
      throw new AppError(402, "PAYMENT_REQUIRED", "The payment doesn't match this game's price.");
    }

    const verification = await resourceServer.verifyPayment(payload, matched);
    if (!verification.isValid) {
      throw new AppError(402, "PAYMENT_REQUIRED", "Payment could not be verified.", {
        reason: verification.invalidReason,
        message: verification.invalidMessage,
      });
    }

    const settlement = await resourceServer.settlePayment(payload, matched);
    if (!settlement.success) {
      throw new AppError(402, "PAYMENT_REQUIRED", "Payment could not be settled.", {
        reason: settlement.errorReason,
      });
    }

    // Settlement is the moment the buyer is entitled to the game, so respond
    // now and do the minting, the split and the sale log in the background.
    // Blocking here would put ~6s of chain round-trips in front of the single
    // most important moment in the product.
    //
    // Awaited, though, because fulfilPurchase records the purchase before it
    // returns and only the chain work runs on. The client asks for the build
    // the instant this responds, and that request checks the record.
    let buyerAccountId = settlement.payer ?? payload.accepted?.payTo;

    // An agent pays with its own wallet on behalf of whoever funded it — the
    // GameKey belongs to that person, not to the agent's own account, which
    // nobody ever logs into. Only honoured when the account that actually
    // signed the payment is a real agent's, so this header changes nothing
    // for an ordinary buyer's own purchase.
    const ownerOverride = req.headers["x-owner-account-id"];
    if (typeof ownerOverride === "string" && settlement.payer) {
      const payerIsAgent = await db.query.wishlistAgents.findFirst({
        where: eq(wishlistAgents.agentAccountId, settlement.payer),
        columns: { id: true },
      });
      if (payerIsAgent) buyerAccountId = ownerOverride;
    }

    if (buyerAccountId) {
      // The amount the payment was actually verified and settled against, not
      // the game's price read a second time. Those are the same number today
      // and stop being the same number the instant a promotion starts or ends
      // between the 402 and the retry — see fulfil.ts#fulfilPurchase.
      const paidUnits = Number(matched.amount ?? owedUnits);
      // `creditUnits` was computed once, above, from the same authenticated
      // caller this challenge was built for — an agent's purchase never has
      // one (no bearer token on that request), so an agent can never redeem a
      // person's trial credit on their behalf without them asking.
      await fulfilPurchase(game, buyerAccountId, settlement.transaction, paidUnits, "purchase", creditUnits);
    }

    res.setHeader("payment-verified", "true");
    res.json({
      buildPath: buildPathFor(game),
      buildCid: game.buildCid,
      tokenId: game.htsTokenId,
      keyStatus: "pending",
      settlementTxId: settlement.transaction,
    });
  }),
);

/**
 * The build itself.
 *
 * One request for the whole zip rather than a request per asset, which is what
 * makes an ownership check affordable here: checking a wallet against the
 * Mirror Node once per game is fine, once per file is not. The client unpacks
 * it and serves it to itself from an isolated origin, which is the same thing
 * the publish preview does with a dropped zip.
 *
 * A game published before builds were kept locally has a CID and no file. That
 * answers 404 with a real reason rather than a broken player.
 */
gameRouter.get(
  "/:id/build.zip",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");
    if (game.status === "removed") throw Errors.notFound("Game");

    if (game.priceUnits > 0) {
      const { owned } = await hasEntitlement(req.auth!.evmAddress, game);
      if (!owned) {
        // A trial serves the same build a purchase does, because that is the
        // entire pitch: the real game, not a separate demo build. One paid
        // chunk is what earns the file.
        //
        // That is not a weaker gate than it looks. The build is unpacked and
        // run in the browser, so a trial was never technically enforceable —
        // see the note above `/:id/trial` — only honoured. Whatever gate goes
        // here, whoever holds the zip holds it. So the honest line is the one
        // that matches what was actually sold: money changed hands for access,
        // and the clock is the client's promise to keep.
        const accountId = await resolveHederaAccount(req.auth!);
        const chunks = accountId ? await trialChunksFor(game.id, accountId) : [];
        if (chunks.length === 0) {
          throw Errors.notOwner("You need to own this game, or a trial chunk of it, to download it.");
        }
      }
    }

    const file = await findBuild(game.id, game.buildZipCid);
    if (!file) {
      // Errors.notFound() appends " not found.", so this takes the subject only.
      // The explanation goes in details, where it doesn't corrupt the sentence.
      throw new AppError(404, "NOT_FOUND", "This game's build file isn't on this server.", {
        reason:
          "This game was published before builds were pinned as a retrievable zip, so the only " +
          "copy is on the machine that uploaded it. Republishing fixes it permanently.",
      });
    }

    res.type("application/zip");
    res.sendFile(file);
  }),
);

// Ownership as the chain reports it, which is what a buyer's own library and
// the review gate rest on. Deliberately narrower than services/games/
// entitlement.ts: this one is the claim that can be checked by anyone.
gameRouter.get(
  "/:id/owned",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");
    const result = await ownsGame(req.auth!.evmAddress, game.htsTokenId);
    res.json(result);
  }),
);

// --- paying for a game --------------------------------------------------
//
// Two calls, because a purchase needs two different authorities and neither
// side has both. This server has the 402 terms and a Hedera client; only the
// browser can sign with the buyer's own embedded wallet. So the transfer is
// built here, signed there, and settled here.
//
// The alternative was asking every buyer to delegate their wallet to us. That
// is a much bigger permission than a purchase needs — it is standing authority
// to move their money whenever we like — and it would have to be granted before
// the first buy, on the checkout screen, in a modal about wallet delegation.
// See services/x402/pay.ts#preparePayment.
//
// The agent does not come through here. Its wallet is one we created, so it can
// still be signed for in one step (services/x402/pay.ts#payForGame).

/**
 * The Hedera account behind a wallet, or the reason there isn't one yet.
 *
 * No public key is looked up here, and that is the whole point. A wallet that
 * has only ever received value has a *hollow* account (HIP-583): it holds the
 * money, its alias is the 20-byte EVM address, and the Mirror Node reports
 * `key: null` until it signs something. That describes every first-time buyer,
 * so demanding a published key up front refused exactly the people we exist to
 * serve. The key comes out of the payment signature instead, and signing the
 * payment is also what completes the account.
 */
async function payerFor(evmAddress: string) {
  const account = await getAccountByEvmAddress(evmAddress);
  if (!account) throw Errors.walletNotFunded();
  return { accountId: account.account };
}

gameRouter.post(
  "/:id/pay/prepare",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");

    // Free or already owned, so there is nothing to sign. Answered here rather
    // than making the client guess from the price, and it means a double
    // purchase costs nothing even if the client does ask.
    const granted = await grantAccess(game, req.auth);
    if (granted) {
      res.json({ status: "granted", ...granted });
      return;
    }

    const payer = await payerFor(req.auth!.evmAddress);
    const result = await preparePayment({
      userId: req.auth!.id,
      gameId: game.id,
      accountId: payer.accountId,
      evmAddress: req.auth!.evmAddress,
      // Handed on so the self-call to /download is made as this buyer. That
      // handler prices a purchase by subtracting their trial credit, and it
      // can only do that for a caller it can see.
      authorization: req.headers.authorization,
    });

    if ("granted" in result) {
      res.json({ status: "granted", ...(result.granted as object) });
      return;
    }
    res.json({ status: "prepared", ...result.prepared });
  }),
);

const completePaymentSchema = z.object({
  intentId: z.string().uuid(),
  signatures: z
    .array(
      z.object({
        hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex hash"),
        signature: z.string().regex(/^0x[0-9a-fA-F]{128,130}$/, "must be a hex signature"),
      }),
    )
    .min(1)
    .max(16),
});

gameRouter.post(
  "/:id/pay/complete",
  requireAuth,
  validate(completePaymentSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof completePaymentSchema>;
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");

    const result = await completePayment({
      userId: req.auth!.id,
      gameId: game.id,
      intentId: body.intentId,
      signatures: body.signatures,
    });
    res.json(result);
  }),
);

// --- paid trials ------------------------------------------------------------
//
// A chunk of play, bought like anything else in this route file — a real
// x402 payment, prepared and signed the same two-step way a purchase is
// (services/x402/pay.ts#prepareTrialChunk). What every chunk paid for adds up
// to credit toward the purchase, applied automatically by /:id/download —
// see services/games/trials.ts. See docs/stage-20.md for the design and the
// reason a build being unpacked in the browser means a trial can't be
// technically enforced, only honoured.

function toTrialUsd(units: number | null, game: { priceAsset: string }) {
  return units === null ? null : toDisplayAmount(units, game.priceAsset);
}

// Public config, plus this caller's own numbers if they're signed in and have
// an account to look up — never anyone else's.
gameRouter.get(
  "/:id/trial",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");

    const buyerAccountId = req.auth ? await resolveHederaAccount(req.auth) : null;
    const status = await trialStatusFor(game, buyerAccountId);

    res.json({
      ...status,
      chunkPriceUsd: toTrialUsd(status.chunkPriceUnits, game),
      worstCaseUsd: toDisplayAmount(status.worstCaseUnits, game.priceAsset),
      spentUsd: toDisplayAmount(status.spentUnits, game.priceAsset),
      creditUsd: toDisplayAmount(status.creditUnits, game.priceAsset),
      owedUsd: toDisplayAmount(status.owedUnits, game.priceAsset),
      asset: game.priceAsset,
      assetDecimals: assetDecimals(game.priceAsset),
    });
  }),
);

/**
 * The gated resource itself — never called directly by a browser. It's what
 * `readChallenge`/`settle` in pay.ts hit as an HTTP client, the same way
 * `payForGame` and `/download` relate. Identifies the buyer from who signed
 * the payment, exactly like `/download` does for an anonymous purchase —
 * there is no bearer token on this request at all, only the settled payment.
 */
gameRouter.get(
  "/:id/trial/chunks/settle",
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");
    if (!trialEnabled(game)) {
      throw new AppError(422, "TRIAL_NOT_ENABLED", "This game doesn't offer a trial.");
    }

    await ensureInitialized();

    const requirements = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: env.X402_NETWORK,
      payTo: env.X402_PAY_TO,
      price: { asset: game.priceAsset, amount: String(game.trialChunkPriceUnits) },
      maxTimeoutSeconds: 180,
    });

    const resourceInfo = {
      url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
      description: `${game.title} — one trial chunk (${game.trialChunkMinutes} min)`,
      mimeType: "application/json",
    };

    const header = readPaymentHeader(req.headers as Record<string, unknown>);
    if (!header) {
      const paymentRequired = await resourceServer.createPaymentRequiredResponse(requirements, resourceInfo);
      res.status(402).json(paymentRequired);
      return;
    }

    const payload = decodePaymentPayload(header);
    const matched = resourceServer.findMatchingRequirements(requirements, payload);
    if (!matched) {
      throw new AppError(402, "PAYMENT_REQUIRED", "The payment doesn't match the trial chunk's price.");
    }

    const verification = await resourceServer.verifyPayment(payload, matched);
    if (!verification.isValid) {
      throw new AppError(402, "PAYMENT_REQUIRED", "Payment could not be verified.", {
        reason: verification.invalidReason,
        message: verification.invalidMessage,
      });
    }

    const settlement = await resourceServer.settlePayment(payload, matched);
    if (!settlement.success) {
      throw new AppError(402, "PAYMENT_REQUIRED", "Payment could not be settled.", {
        reason: settlement.errorReason,
      });
    }

    const buyerAccountId = settlement.payer ?? payload.accepted?.payTo;
    if (buyerAccountId) {
      // How many chunks this account has already paid for on this game,
      // checked against the cap here rather than trusted from the client —
      // the same "never trust a stale snapshot" reasoning as everywhere else
      // gated on the Mirror Node. The payment already settled by this point,
      // so a chunk bought past the cap is still recorded (money moved, the
      // record has to be honest) but the max is enforced by `/prepare`
      // refusing to build one in the first place — this is the backstop.
      const paidUnits = Number(matched.amount ?? game.trialChunkPriceUnits);
      await fulfilPurchase(game, buyerAccountId, settlement.transaction, paidUnits, "trial_chunk");
    }

    res.setHeader("payment-verified", "true");
    res.json({
      chunkMinutes: game.trialChunkMinutes,
      settlementTxId: settlement.transaction,
    });
  }),
);

gameRouter.post(
  "/:id/trial/chunks/prepare",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");
    if (!trialEnabled(game)) {
      throw new AppError(422, "TRIAL_NOT_ENABLED", "This game doesn't offer a trial.");
    }

    const buyerAccountId = await resolveHederaAccount(req.auth!);
    if (!buyerAccountId) throw Errors.walletNotFunded();

    // The cap is enforced here, before a transfer is even built — a chunk
    // that would push past `trialMaxChunks` is refused rather than sold and
    // then somehow un-sold. Read fresh, not trusted from an earlier response.
    const status = await trialStatusFor(game, buyerAccountId);
    if (status.chunksLeft <= 0) {
      throw new AppError(409, "TRIAL_CHUNKS_EXHAUSTED", "No trial chunks left for this game.");
    }

    const result = await prepareTrialChunk({
      userId: req.auth!.id,
      gameId: game.id,
      accountId: buyerAccountId,
      evmAddress: req.auth!.evmAddress,
      authorization: req.headers.authorization,
    });

    if ("granted" in result) {
      // Not a real path today — the settle route always prices a chunk above
      // zero — but kept rather than assumed away, the same as /pay/prepare.
      res.json({ status: "granted", ...(result.granted as object) });
      return;
    }
    res.json({ status: "prepared", ...result.prepared });
  }),
);

gameRouter.post(
  "/:id/trial/chunks/complete",
  requireAuth,
  validate(completePaymentSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof completePaymentSchema>;
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");

    const result = await completeTrialChunk({
      userId: req.auth!.id,
      gameId: game.id,
      intentId: body.intentId,
      signatures: body.signatures,
    });
    res.json(result);
  }),
);

// --- reviews ------------------------------------------------------------

const listReviewsSchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(50).default(20),
});

gameRouter.get(
  "/:id/reviews",
  validate(listReviewsSchema, "query"),
  asyncHandler(async (req, res) => {
    const { cursor, limit } = req.query as unknown as z.infer<typeof listReviewsSchema>;
    // Resolved rather than used raw: the segment may be a slug, and a game that
    // doesn't exist should say so instead of returning an empty list that reads
    // like a game with no reviews.
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");

    const rows = await db.query.reviews.findMany({
      where: and(eq(reviews.gameId, game.id), cursor ? lt(reviews.createdAt, new Date(cursor)) : undefined),
      orderBy: desc(reviews.createdAt),
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // Batched identity, shared with comments below so the same person is named
    // the same way in both lists. `author` stays a plain string for the clients
    // already rendering one; `authorProfile` is what links somewhere.
    const authors = await authorSummaries(page.map((r) => r.userId));

    res.json({
      reviews: page.map((r) => ({
        ...r,
        author: authors.get(r.userId)?.label ?? truncateAddress("0x0"),
        authorIsEns: false,
        authorProfile: authors.get(r.userId) ?? null,
      })),
      nextCursor: hasMore ? page[page.length - 1]!.createdAt.toISOString() : null,
    });
  }),
);

const postReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().min(1).max(2000),
});

gameRouter.post(
  "/:id/reviews",
  requireAuth,
  validate(postReviewSchema),
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");

    const { owned } = await ownsGame(req.auth!.evmAddress, game.htsTokenId);
    if (!owned) throw Errors.notOwner("You need to own this game to review it.");

    const [review] = await db
      .insert(reviews)
      .values({ gameId: game.id, userId: req.auth!.id, rating: req.body.rating, body: req.body.body })
      .returning();

    res.status(201).json(review);
  }),
);

// --- the wishlist --------------------------------------------------------
//
// Three routes over one list. `POST /like` is the toggle the client already
// calls and still works exactly as it did; the explicit add and remove exist
// because a toggle is the wrong shape for a button that says "on your
// wishlist" — pressing it twice by accident should not silently undo itself.
//
// No ownership gate anywhere here: saving a game you have not bought is the
// entire point, unlike a review.

/** The same body for all three, so the client updates state identically. */
async function wishlistState(gameId: string, userId: string, onList: boolean) {
  const count = await wishlistCount(gameId);
  // `liked` and `likeCount` are the old names for exactly these two numbers.
  // Kept so nothing already rendering them has to change on the same day the
  // list gained a purpose.
  return { wishlisted: onList, wishlistCount: count, liked: onList, likeCount: count };
}

gameRouter.post(
  "/:id/like",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");

    const existing = await db.query.wishlistItems.findFirst({
      where: and(eq(wishlistItems.gameId, game.id), eq(wishlistItems.userId, req.auth!.id)),
    });

    if (existing) {
      await removeFromWishlist(game.id, req.auth!.id);
    } else {
      await addToWishlist(game, req.auth!.id);
      void announceDemandIfMilestone(game).catch((err) =>
        logger.error({ err, gameId: game.id }, "announcing demand failed"),
      );
    }

    res.json(await wishlistState(game.id, req.auth!.id, !existing));
  }),
);

gameRouter.post(
  "/:id/wishlist",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");

    const { added } = await addToWishlist(game, req.auth!.id);
    if (added) {
      // Not awaited: a topic write takes seconds and the person clicked a
      // heart. Failing to announce a milestone must not fail the save.
      void announceDemandIfMilestone(game).catch((err) =>
        logger.error({ err, gameId: game.id }, "announcing demand failed"),
      );
    }

    res.status(added ? 201 : 200).json(await wishlistState(game.id, req.auth!.id, true));
  }),
);

gameRouter.delete(
  "/:id/wishlist",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");
    await removeFromWishlist(game.id, req.auth!.id);
    res.json(await wishlistState(game.id, req.auth!.id, false));
  }),
);

// Upgrading a plain wishlist row into a "want" the agent may act on — see
// wishlist-agent-spec.md §2. Deliberately not a separate table: same row,
// one extra field, so un-wishlisting a game removes the want along with it
// and there is exactly one list to look at rather than two that can disagree.
const setWantSchema = z
  .object({
    // Null clears the want and leaves a plain wishlist entry. Omit to leave
    // it as it is.
    agentMaxUnits: z.number().int().positive().nullable().optional(),
    agentNote: z.string().max(280).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to change" });

gameRouter.patch(
  "/:id/wishlist",
  requireAuth,
  validate(setWantSchema),
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");
    const body = req.body as z.infer<typeof setWantSchema>;

    const item = await db.query.wishlistItems.findFirst({
      where: and(eq(wishlistItems.gameId, game.id), eq(wishlistItems.userId, req.auth!.id)),
    });
    if (!item) {
      throw Errors.validationFailed({ game: "wishlist this game first — POST /api/games/:id/wishlist" });
    }

    const fields: { agentMaxUnits?: number | null; agentNote?: string | null } = {};

    if (body.agentMaxUnits !== undefined) {
      if (body.agentMaxUnits !== null) {
        const agent = await db.query.wishlistAgents.findFirst({ where: eq(wishlistAgents.buyerUserId, req.auth!.id) });
        if (!agent) {
          throw new AppError(422, "NO_AGENT", "Set up your agent first.", { setupUrl: "/api/me/agent" });
        }
        // The minimum-stake rule: a want is only as real as the money behind
        // it. Checked against the wallet's live balance, not a number we
        // remembered, for the same reason every balance in this app is read
        // fresh rather than cached.
        const balance = await agentBalance(agent);
        if (balance < BigInt(body.agentMaxUnits)) {
          // Said in money, not in units. This is the one refusal here a person
          // sees routinely — setting a ceiling before funding the agent — and
          // "your agent's wallet holds 0" was both true and useless.
          const held = toDisplayAmount(Number(balance), env.X402_ASSET);
          const decimals = assetDecimals(env.X402_ASSET);
          throw Errors.validationFailed({
            agentMaxUnits: `your agent holds $${held.toFixed(decimals)}, so it cannot promise this much. Add money to it first.`,
          });
        }
      }
      fields.agentMaxUnits = body.agentMaxUnits;
    }
    if (body.agentNote !== undefined) fields.agentNote = body.agentNote;

    const [updated] = await db.update(wishlistItems).set(fields).where(eq(wishlistItems.id, item.id)).returning();
    res.json({
      gameId: game.id,
      agentMaxUnits: updated!.agentMaxUnits,
      agentNote: updated!.agentNote,
    });
  }),
);

// Public, because that is the whole point of it.
//
// Wishlist numbers everywhere else are private platform data — Steam will not
// give them away, because knowing what people want before they buy is the moat.
// Here the count is on a public topic at every milestone, so a developer can
// act on real demand and anyone can check the number independently.
gameRouter.get(
  "/:id/demand",
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game || game.status === "removed") throw Errors.notFound("Game");
    res.json({
      gameId: game.id,
      wishlistCount: await wishlistCount(game.id),
      announcedMilestone: game.demandMilestone,
      topicId: env.HCS_LISTINGS_TOPIC ?? null,
    });
  }),
);

// --- play sessions ---------------------------------------------------------
// Timed the honest way: started when the client actually boots the game
// (after /download or /pay hands back a playUrl), ended by an explicit call.
// A tab that just closes leaves a session with no endedAt — it still counts
// once toward `plays` (see playsFor above), it just never earns a duration.

const MAX_SESSION_SECONDS = 12 * 60 * 60; // a session left open past this is an abandoned tab, not real playtime

gameRouter.post(
  "/:id/sessions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");
    if (game.status === "removed") throw Errors.notFound("Game");

    // hasEntitlement, not ownsGame. The first play of any purchase happens in
    // the seconds between settlement and the GameKey landing, so gating this on
    // the chain alone would drop the play count for exactly the play that
    // matters most, and 403 the buyer as the game boots.
    if (game.priceUnits > 0) {
      const { owned } = await hasEntitlement(req.auth!.evmAddress, game);
      if (!owned) throw Errors.notOwner("You need to own this game to play it.");
    }

    const [session] = await db
      .insert(playSessions)
      .values({ gameId: game.id, userId: req.auth!.id })
      .returning();

    res.status(201).json({ sessionId: session!.id, startedAt: session!.startedAt });
  }),
);

gameRouter.patch(
  "/:id/sessions/:sessionId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const session = await db.query.playSessions.findFirst({
      where: eq(playSessions.id, param(req, "sessionId")),
    });
    if (!session || session.gameId !== param(req, "id")) throw Errors.notFound("Play session");
    if (session.userId !== req.auth!.id) throw Errors.notOwner();

    // idempotent — a duplicate "end" call (a beforeunload handler racing a
    // manual close, say) isn't an error, it's the same session reported twice.
    if (session.endedAt) {
      res.json(session);
      return;
    }

    const endedAt = new Date();
    const rawSeconds = Math.round((endedAt.getTime() - session.startedAt.getTime()) / 1000);
    const durationSeconds = Math.max(0, Math.min(rawSeconds, MAX_SESSION_SECONDS));

    const [updated] = await db
      .update(playSessions)
      .set({ endedAt, durationSeconds })
      .where(eq(playSessions.id, session.id))
      .returning();

    res.json(updated);
  }),
);

// --- cloud saves -----------------------------------------------------------
//
// A build runs sandboxed on its own origin, so anything it writes to
// localStorage or IndexedDB belongs to that browser on that machine. Clearing
// site data or opening the game on a phone loses it. These four routes are the
// somewhere-else it can live.
//
// Gated the same way play sessions are, and for the same reason: a paid game
// needs entitlement, a free one does not, and the check uses `hasEntitlement`
// rather than the chain alone so the first save of a fresh purchase is not
// refused in the seconds before the GameKey lands.

async function saveGameFor(req: Request) {
  const game = await findGameByRef(param(req, "id"));
  if (!game) throw Errors.notFound("Game");
  if (game.status === "removed") throw Errors.notFound("Game");
  if (game.priceUnits > 0) {
    const { owned } = await hasEntitlement(req.auth!.evmAddress, game);
    if (!owned) throw Errors.notOwner("You need to own this game to sync its saves.");
  }
  return game;
}

gameRouter.get(
  "/:id/saves",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await saveGameFor(req);
    res.json({
      slots: await listSaves(game.id, req.auth!.id),
      maxSlots: MAX_SLOTS,
      maxBytes: MAX_SAVE_BYTES,
    });
  }),
);

gameRouter.get(
  "/:id/saves/:slot",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await saveGameFor(req);
    const save = await readSave(game.id, req.auth!.id, Number(param(req, "slot")));
    if (!save) throw Errors.notFound("Save");
    res.json(save);
  }),
);

const putSaveSchema = z.object({
  // Opaque. Whatever the client dumped out of the game's own storage — we never
  // parse it, which is what keeps this working for any engine.
  data: z.string().min(1),
  label: z.string().max(60).nullable().optional(),
  device: z.string().max(60).nullable().optional(),
  // The version the client last read. Sending it turns a blind overwrite into a
  // detectable conflict — see services/games/saves.ts#writeSave.
  baseVersion: z.number().int().nonnegative().optional(),
});

gameRouter.put(
  "/:id/saves/:slot",
  requireAuth,
  validate(putSaveSchema),
  asyncHandler(async (req, res) => {
    const game = await saveGameFor(req);
    const body = req.body as z.infer<typeof putSaveSchema>;
    const result = await writeSave(game, req.auth!.id, Number(param(req, "slot")), body);
    res.status(result.created ? 201 : 200).json(result);
  }),
);

gameRouter.delete(
  "/:id/saves/:slot",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await saveGameFor(req);
    const removed = await deleteSave(game.id, req.auth!.id, Number(param(req, "slot")));
    res.json({ deleted: removed, slot: Number(param(req, "slot")) });
  }),
);

// --- comments --------------------------------------------------------------
// Unrestricted discussion, unlike reviews: no ownership gate, no rating.
// Same cursor pagination and same batched-author-lookup pattern as reviews
// above, deliberately, so the two read the same way.

const listCommentsSchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(50).default(20),
});

gameRouter.get(
  "/:id/comments",
  validate(listCommentsSchema, "query"),
  asyncHandler(async (req, res) => {
    const { cursor, limit } = req.query as unknown as z.infer<typeof listCommentsSchema>;
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");

    const rows = await db.query.comments.findMany({
      where: and(
        eq(comments.gameId, game.id),
        cursor ? lt(comments.createdAt, new Date(cursor)) : undefined,
      ),
      orderBy: desc(comments.createdAt),
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const authors = await authorSummaries(page.map((c) => c.userId));

    res.json({
      comments: page.map((c) => ({
        ...c,
        author: authors.get(c.userId)?.label ?? truncateAddress("0x0"),
        authorIsEns: false,
        authorProfile: authors.get(c.userId) ?? null,
      })),
      nextCursor: hasMore ? page[page.length - 1]!.createdAt.toISOString() : null,
    });
  }),
);

const postCommentSchema = z.object({ body: z.string().min(1).max(2000) });

gameRouter.post(
  "/:id/comments",
  requireAuth,
  validate(postCommentSchema),
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game) throw Errors.notFound("Game");

    const [comment] = await db
      .insert(comments)
      .values({ gameId: game.id, userId: req.auth!.id, body: req.body.body })
      .returning();

    res.status(201).json(comment);
  }),
);

export default gameRouter;
