import { Router } from "express";
import { and, desc, asc, eq, or, ilike, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import multer from "multer";
import { db } from "../db/client.js";
import { games, studios, studioMembers, splits, reviews, gameMedia, notifications } from "../db/schema.js";
import { requireAuth, optionalAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError, Errors } from "../lib/errors.js";
import { slugify, withSuffix } from "../lib/slug.js";
import { ownsGame } from "../services/games/ownership.js";
import { env } from "../config/env.js";
import { param } from "../lib/params.js";
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

const catalogQuerySchema = z.object({
  search: z.string().max(200).optional(),
  tag: z.string().max(40).optional(),
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
    const { search, tag, sort, freeOnly, cursor, limit } =
      req.query as unknown as z.infer<typeof catalogQuerySchema>;

    const where = and(
      eq(games.status, "published"),
      search ? ilike(games.title, `%${search}%`) : undefined,
      tag ? sql`${games.tags} @> ARRAY[${tag}]::text[]` : undefined,
      freeOnly ? eq(games.priceUnits, 0) : undefined,
    );

    const orderBy =
      sort === "price-low"
        ? asc(games.priceUnits)
        : sort === "price-high"
          ? desc(games.priceUnits)
          : desc(games.publishedAt); // "rating" falls back to newest — see note below

    // rating sort needs the join-computed average, which we compute after
    // the page is fetched (see ratingsFor). Sorting a page-then-fetched
    // aggregate is wrong in general, but at this catalog's size it's the
    // pragmatic call over pulling in a real aggregate query today.
    const rows = await db.query.games.findMany({
      where,
      orderBy,
      limit: limit + 1,
      offset: cursor,
      with: { studio: true },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const ids = page.map((g) => g.id);

    const [ratings, splitRows] = await Promise.all([
      ratingsFor(ids),
      db.query.splits.findMany({ where: inArray(splits.gameId, ids) }),
    ]);
    const splitsByGame = new Map<string, typeof splitRows>();
    for (const s of splitRows) splitsByGame.set(s.gameId, [...(splitsByGame.get(s.gameId) ?? []), s]);

    res.json({
      games: page.map((g) => serializeGame(g, splitsByGame.get(g.id) ?? [], ratings.get(g.id))),
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
      where: or(eq(games.id, idOrSlug), eq(games.slug, idOrSlug)),
      with: { studio: true },
    });
    if (!game) throw Errors.notFound("Game");

    const [gameSplits, media, ratings] = await Promise.all([
      db.query.splits.findMany({ where: eq(splits.gameId, game.id) }),
      db.query.gameMedia.findMany({ where: eq(gameMedia.gameId, game.id), orderBy: asc(gameMedia.position) }),
      ratingsFor([game.id]),
    ]);

    let owned: boolean | undefined;
    if (req.auth) {
      owned = (await ownsGame(req.auth.evmAddress, game.htsTokenId)).owned;
    }

    res.json({ ...serializeGame(game, gameSplits, ratings.get(game.id)), media, owned });
  }),
);

function serializeGame(
  game: typeof games.$inferSelect & { studio: typeof studios.$inferSelect },
  gameSplits: (typeof splits.$inferSelect)[],
  rating?: { rating: number; reviewCount: number },
) {
  return {
    id: game.id,
    slug: game.slug,
    title: game.title,
    tagline: game.tagline,
    description: game.description,
    studio: { id: game.studio.id, name: game.studio.name, ens: game.studio.ensSubname, slug: game.studio.slug },
    priceUnits: game.priceUnits,
    priceAsset: game.priceAsset,
    tags: game.tags,
    coverCid: game.coverCid,
    coverSeed: game.coverSeed,
    publishedAt: game.publishedAt,
    splits: gameSplits.map((s) => ({ handle: s.handle, role: s.role, pct: s.pct })),
    rating: rating?.rating ?? 0,
    reviewCount: rating?.reviewCount ?? 0,
    buildKb: game.buildSizeKb,
  };
}

// --- publish pipeline -------------------------------------------------
// Stage 1/2 boundary: metadata, splits and the draft row are real today.
// File pinning, the CSAM gate, and HTS token creation are Stage 2 and throw
// NOT_IMPLEMENTED below rather than pretending to succeed.

const splitSchema = z.object({
  wallet: z.string().min(1),
  handle: z.string().min(1).max(40),
  role: z.string().min(1).max(40),
  pct: z.number().int().min(1).max(100),
});

const publishGameSchema = z.object({
  studioId: z.string().uuid(),
  title: z.string().min(1).max(120),
  tagline: z.string().max(200).default(""),
  description: z.string().max(5000).default(""),
  tags: z.array(z.string().max(40)).max(10).default([]),
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

    await db.insert(splits).values(body.splits.map((s) => ({ gameId: game!.id, ...s })));

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

    res.status(201).json(game);
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
          payload: { gameId: game.id, title: game.title },
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

    const result = await payForGame(game.id, {
      walletId: req.auth!.privyWalletId,
      accountId: account.account,
      publicKeyHex: req.auth!.publicKeyHex,
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
    res.json({ reviews: page, nextCursor: hasMore ? page[page.length - 1]!.createdAt.toISOString() : null });
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

export default gameRouter;
