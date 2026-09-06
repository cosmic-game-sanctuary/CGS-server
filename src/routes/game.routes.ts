import { Router } from "express";
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
  likes,
  comments,
} from "../db/schema.js";
import { truncateAddress } from "../lib/address.js";
import { requireAuth, optionalAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError, Errors } from "../lib/errors.js";
import { slugify, withSuffix } from "../lib/slug.js";
import { ownsGame } from "../services/games/ownership.js";
import { ensureUserPublicKey } from "../services/users/repo.js";
import { env } from "../config/env.js";
import { param, isUuid } from "../lib/params.js";
import { assetDecimals, ensFullName, toDisplayAmount } from "../lib/display.js";
import { unpackBuild } from "../services/ipfs/unpack.js";
import { pinDirectory, pinFile, gatewayUrl } from "../services/ipfs/pinata.js";
import {
  resourceServer,
  ensureInitialized,
  readPaymentHeader,
  decodePaymentPayload,
} from "../services/x402/server.js";
import { fulfilPurchase } from "../services/games/fulfil.js";
import { getAccountByEvmAddress } from "../services/hedera/mirror.js";
import { payForGame } from "../services/x402/pay.js";
import { checkImages } from "../services/moderation/csam.js";
import { createGameToken } from "../services/hedera/hts.js";
import { submitTopicMessage } from "../services/hedera/hcs.js";

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
    db.query.studioMembers.findMany({
      where: inArray(studioMembers.studioId, studioIds),
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

async function likeCountsFor(gameIds: string[]) {
  if (gameIds.length === 0) return new Map<string, number>();
  const rows = await db.query.likes.findMany({
    where: inArray(likes.gameId, gameIds),
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

    res.json({
      games: page.map((g) =>
        serializeGame(
          g,
          splitsByGame.get(g.id) ?? [],
          ratings.get(g.id),
          plays.get(g.id),
          likeCounts.get(g.id),
          studioExtras.get(g.studioId),
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

    let owned: boolean | undefined;
    let liked: boolean | undefined;
    if (req.auth) {
      owned = (await ownsGame(req.auth.evmAddress, game.htsTokenId)).owned;
      liked = !!(await db.query.likes.findFirst({
        where: and(eq(likes.gameId, game.id), eq(likes.userId, req.auth.id)),
      }));
    }

    res.json({
      ...serializeGame(
        game,
        gameSplits,
        ratings.get(game.id),
        plays.get(game.id),
        likeCounts.get(game.id),
        studioExtras.get(game.studioId),
      ),
      // the client shows screenshots from a gateway URL, so send the CID it
      // needs rather than making it know how we address IPFS.
      media: media.map((m) => ({ id: m.id, kind: m.kind, cid: m.cid, position: m.position, url: gatewayUrl(m.cid) })),
      owned,
      liked,
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
    splits: gameSplits.map((s) => ({ handle: s.handle, role: s.role, pct: s.pct })),
    rating: rating?.rating ?? 0,
    reviewCount: rating?.reviewCount ?? 0,
    // a real count at last, batched the same way rating is above — the
    // contract has promised this field since Stage 1 and nothing ever
    // incremented it. See playSessions in db/schema.ts.
    plays: plays ?? 0,
    likeCount: likeCount ?? 0,
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

const IMAGE_MIME = /^image\//;

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
  if (existing) return { ...existing, createdHere: false };

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

    const buildFiles = await unpackBuild(files.build[0]!.buffer);

    // fails closed: nothing below this point runs — nothing gets pinned,
    // nothing gets inserted — until this passes. See services/moderation/csam.ts.
    const imagesToCheck = [
      ...mediaFiles.map((f) => f.buffer),
      ...buildFiles.filter((f) => IMAGE_MIME.test(f.mimeType ?? "")).map((f) => f.buffer),
    ];
    const csam = await checkImages(imagesToCheck);
    if (!csam.pass) {
      throw new AppError(422, "MODERATION_BLOCKED", "This upload can't be accepted yet.", {
        reason: csam.reason,
      });
    }

    let slug = slugify(body.title);
    if (await db.query.games.findFirst({ where: eq(games.slug, slug) })) slug = withSuffix(slug);

    const buildCid = await pinDirectory(buildFiles);
    const buildSizeKb = Math.round(buildFiles.reduce((sum, f) => sum + f.buffer.length, 0) / 1024);

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
        buildCid,
        buildSizeKb,
        priceUnits: body.priceUnits,
        priceAsset: body.priceAsset,
        status: "draft",
      })
      .returning();

    // Resolve each share to whoever it belongs to, creating the studio
    // membership for anyone named only by email. That row *is* the invite —
    // /invite/:id takes a studio_members id — so publishing with a teammate
    // added by email is what sends them one, with no separate call.
    const resolved = await resolveSplitRecipients(studio.id, body.splits);

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
    const game = await db.query.games.findFirst({ where: eq(games.id, param(req, "id")) });
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

    await submitTopicMessage(env.HCS_LISTINGS_TOPIC!, {
      gameId: game.id,
      slug: game.slug,
      title: game.title,
      studioId: game.studioId,
      priceUnits: game.priceUnits,
      priceAsset: game.priceAsset,
      tokenId,
      publishedAt: published!.publishedAt,
    });

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
    const game = await db.query.games.findFirst({ where: eq(games.id, param(req, "id")) });
    if (!game) throw Errors.notFound("Game");
    if (game.status === "removed") throw Errors.notFound("Game");
    if (game.status === "draft") throw Errors.gameNotPublished();
    if (!game.buildCid) throw Errors.gameNotPublished("This game has no build pinned.");

    const playUrl = gatewayUrl(game.buildCid, "index.html");

    if (game.priceUnits === 0) {
      if (req.auth) await grantFreeKey(game, req.auth.evmAddress);
      res.json({ playUrl, tokenId: game.htsTokenId, keyStatus: "free" });
      return;
    }

    if (req.auth) {
      const { owned, serial } = await ownsGame(req.auth.evmAddress, game.htsTokenId);
      if (owned) {
        res.json({ playUrl, tokenId: game.htsTokenId, serial, keyStatus: "owned" });
        return;
      }
    }

    await ensureInitialized();

    const requirements = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: env.X402_NETWORK,
      payTo: env.X402_PAY_TO,
      price: { asset: game.priceAsset, amount: String(game.priceUnits) },
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
    const buyerAccountId = settlement.payer ?? payload.accepted?.payTo;
    if (buyerAccountId) {
      void fulfilPurchase(game, buyerAccountId, settlement.transaction);
    }

    res.setHeader("payment-verified", "true");
    res.json({
      playUrl,
      tokenId: game.htsTokenId,
      keyStatus: "pending",
      settlementTxId: settlement.transaction,
    });
  }),
);

// A free game still mints a real GameKey — `price = 0` is a real purchase
// with real ownership, not a bypass.
async function grantFreeKey(game: typeof games.$inferSelect, buyerEvmAddress: string) {
  const { owned } = await ownsGame(buyerEvmAddress, game.htsTokenId);
  if (owned) return;
  const account = await getAccountByEvmAddress(buyerEvmAddress);
  if (!account) return; // wallet never funded — nothing to mint to yet
  void fulfilPurchase(game, account.account, "free");
}

gameRouter.get(
  "/:id/owned",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await db.query.games.findFirst({ where: eq(games.id, param(req, "id")) });
    if (!game) throw Errors.notFound("Game");
    const result = await ownsGame(req.auth!.evmAddress, game.htsTokenId);
    res.json(result);
  }),
);

// The browser can't hold a signing key, so a logged-in buyer's purchase is
// signed here instead — with their own Privy wallet, not ours. This is the
// "helper" INTEGRATION.md tells the frontend to call rather than building a
// Hedera transaction client-side. Same response shape as GET /:id/download.
gameRouter.post(
  "/:id/pay",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await db.query.games.findFirst({ where: eq(games.id, param(req, "id")) });
    if (!game) throw Errors.notFound("Game");

    const account = await getAccountByEvmAddress(req.auth!.evmAddress);
    if (!account) throw Errors.walletNotFunded();

    // The first thing here that needs signing authority over the buyer's own
    // wallet, and the only thing that does. Privy refuses unless the user has
    // delegated it, so say that plainly rather than letting a raw Privy error
    // surface on the one screen where the money is about to move.
    let publicKeyHex: string;
    try {
      publicKeyHex = await ensureUserPublicKey(req.auth!);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/authorization keys|user signing keys/i.test(message)) {
        throw new AppError(
          403,
          "WALLET_NOT_DELEGATED",
          "This wallet hasn't authorised the store to pay on its behalf yet.",
          { reason: message },
        );
      }
      throw err;
    }

    const result = await payForGame(game.id, {
      walletId: req.auth!.privyWalletId,
      accountId: account.account,
      publicKeyHex,
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
    const rows = await db.query.reviews.findMany({
      where: and(eq(reviews.gameId, param(req, "id")), cursor ? lt(reviews.createdAt, new Date(cursor)) : undefined),
      orderBy: desc(reviews.createdAt),
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // batched, not a relation — this is the only place reviews need the
    // author's address, and it's read-only display, same pattern as the
    // catalog's rating batching above.
    const authorIds = [...new Set(page.map((r) => r.userId))];
    const authors =
      authorIds.length > 0
        ? await db.query.users.findMany({ where: inArray(users.id, authorIds), columns: { id: true, evmAddress: true } })
        : [];
    const authorById = new Map(authors.map((a) => [a.id, a.evmAddress]));

    res.json({
      reviews: page.map((r) => ({
        ...r,
        // no ENS lookup exists yet (Stage 7) — a truncated address is the
        // only identity there is to show right now, for anyone.
        author: truncateAddress(authorById.get(r.userId) ?? "0x0"),
        authorIsEns: false,
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
    const game = await db.query.games.findFirst({ where: eq(games.id, param(req, "id")) });
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

// --- likes ---------------------------------------------------------------
// A toggle, not a growing log: liking twice unlikes. No ownership gate on
// purpose — favoriting a game you haven't bought yet is normal (Steam
// wishlists, itch.io favorites), unlike a review, which is a
// verified-purchase signal.

gameRouter.post(
  "/:id/like",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await db.query.games.findFirst({ where: eq(games.id, param(req, "id")) });
    if (!game) throw Errors.notFound("Game");

    const existing = await db.query.likes.findFirst({
      where: and(eq(likes.gameId, game.id), eq(likes.userId, req.auth!.id)),
    });

    if (existing) {
      await db.delete(likes).where(eq(likes.id, existing.id));
    } else {
      await db.insert(likes).values({ gameId: game.id, userId: req.auth!.id });
    }

    const rows = await db.query.likes.findMany({ where: eq(likes.gameId, game.id), columns: { id: true } });
    res.json({ liked: !existing, likeCount: rows.length });
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
    const game = await db.query.games.findFirst({ where: eq(games.id, param(req, "id")) });
    if (!game) throw Errors.notFound("Game");
    if (game.status === "removed") throw Errors.notFound("Game");

    if (game.priceUnits > 0) {
      const { owned } = await ownsGame(req.auth!.evmAddress, game.htsTokenId);
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
    const rows = await db.query.comments.findMany({
      where: and(
        eq(comments.gameId, param(req, "id")),
        cursor ? lt(comments.createdAt, new Date(cursor)) : undefined,
      ),
      orderBy: desc(comments.createdAt),
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const authorIds = [...new Set(page.map((c) => c.userId))];
    const authors =
      authorIds.length > 0
        ? await db.query.users.findMany({ where: inArray(users.id, authorIds), columns: { id: true, evmAddress: true } })
        : [];
    const authorById = new Map(authors.map((a) => [a.id, a.evmAddress]));

    res.json({
      comments: page.map((c) => ({
        ...c,
        author: truncateAddress(authorById.get(c.userId) ?? "0x0"),
        authorIsEns: false,
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
    const game = await db.query.games.findFirst({ where: eq(games.id, param(req, "id")) });
    if (!game) throw Errors.notFound("Game");

    const [comment] = await db
      .insert(comments)
      .values({ gameId: game.id, userId: req.auth!.id, body: req.body.body })
      .returning();

    res.status(201).json(comment);
  }),
);

export default gameRouter;
