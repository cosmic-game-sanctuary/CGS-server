import { Router } from "express";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import multer from "multer";
import { db } from "../db/client.js";
import {
  games,
  gameMedia,
  gameBuilds,
  gameKeys,
  gamePriceChanges,
  sales,
  splits,
  reviews,
  comments,
  likes,
  playSessions,
  notifications,
  users,
  wishlistAgents,
  wishlistItems,
  saveStates,
  gamePromotions,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError, Errors } from "../lib/errors.js";
import { param } from "../lib/params.js";
import { assetDecimals, toDisplayAmount } from "../lib/display.js";
import { loadManageableGame } from "../services/studios/access.js";
import { findGameByRef } from "../services/games/lookup.js";
import { ingestBuild, commitBuild, listBuilds } from "../services/games/builds.js";
import { announce, changePrice, priceHistory } from "../services/games/listing.js";
import { notifyPriceDrop, wishlistCount } from "../services/games/wishlist.js";
import {
  activePromotionFor,
  createPromotion,
  endPromotion,
  extendPromotion,
  promotionHistory,
  serializePromotion,
} from "../services/games/promotions.js";
import { deleteBuild } from "../services/games/buildStore.js";
import { gatewayUrl, pinFile, unpinByCid } from "../services/ipfs/pinata.js";
import { checkImages } from "../services/moderation/csam.js";
import logger from "../utils/logger.utils.js";

/**
 * Everything a developer does to a game *after* it exists.
 *
 * Mounted on /api/games alongside game.routes.ts, which is the public and
 * buying half. The split is by audience rather than by URL: these are the
 * routes a studio calls about its own work, they all check the same
 * `canManageStudio` permission, and none of them are reachable by a stranger.
 *
 * The gap this closes was the biggest one in the product. There was no PATCH
 * on a game at all — a published game was frozen forever, which meant a typo
 * was permanent, a price could never move (so the wishlist agent could never
 * fire), and shipping a patch meant publishing a second game that split its
 * reviews, sales and owners away from the first.
 */
const gameManageRouter = Router({ caseSensitive: true, strict: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

/** Load the game and refuse unless this caller may change it. */
async function requireManageable(gameId: string, userId: string) {
  const { game, canManage } = await loadManageableGame(gameId, userId);
  if (!game) throw Errors.notFound("Game");
  if (!canManage) throw Errors.notOwner("Only this game's studio can change it.");
  // `removed` is a moderation outcome — the build is unpinned and gone. There
  // is nothing left to edit and letting someone tidy up the listing of removed
  // content would be the wrong thing to allow.
  if (game.status === "removed") throw Errors.notFound("Game");
  return game;
}

// --- editing the listing ---------------------------------------------------

const editGameSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    tagline: z.string().max(200).optional(),
    description: z.string().max(5000).optional(),
    tags: z.array(z.string().max(40)).max(10).optional(),
    // Integer smallest-units, like every other amount in this API. Zero is
    // legal and means the game becomes free — a real choice, not a mistake.
    priceUnits: z.number().int().nonnegative().optional(),
    // An existing media row to promote to cover. Null clears it. Uploading new
    // art is POST /:id/media; this only picks which of it is the cover.
    coverMediaId: z.string().uuid().nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "nothing to change" });

gameManageRouter.patch(
  "/:id",
  requireAuth,
  validate(editGameSchema),
  asyncHandler(async (req, res) => {
    const game = await requireManageable(param(req, "id"), req.auth!.id);
    const body = req.body as z.infer<typeof editGameSchema>;

    // The slug deliberately does not follow the title. It is in every link
    // anyone has shared, in every HCS message this game has ever produced, and
    // in the agent's own record of what it is watching. A game that renames
    // itself keeps its address, the same way a person who changes their name
    // keeps their phone number.
    const fields: Partial<typeof games.$inferInsert> = {};
    if (body.title !== undefined) fields.title = body.title;
    if (body.tagline !== undefined) fields.tagline = body.tagline;
    if (body.description !== undefined) fields.description = body.description;
    if (body.tags !== undefined) fields.tags = body.tags;

    if (body.coverMediaId !== undefined) {
      if (body.coverMediaId === null) {
        fields.coverCid = null;
      } else {
        const media = await db.query.gameMedia.findFirst({
          where: and(eq(gameMedia.id, body.coverMediaId), eq(gameMedia.gameId, game.id)),
        });
        if (!media) throw Errors.validationFailed({ coverMediaId: "no such image on this game" });
        if (media.kind !== "image") {
          throw Errors.validationFailed({ coverMediaId: "a cover has to be an image" });
        }
        fields.coverCid = media.cid;
      }
    }

    let updated = game;
    if (Object.keys(fields).length > 0) {
      const [row] = await db
        .update(games)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(games.id, game.id))
        .returning();
      updated = row!;
    }

    // Price is handled apart from the rest because it is the only field that
    // has to reach the public topic — see services/games/listing.ts. Done last
    // so the message it sends carries the new title too.
    let priceChanged: Awaited<ReturnType<typeof changePrice>> | null = null;
    if (body.priceUnits !== undefined && body.priceUnits !== game.priceUnits) {
      // A running sale owns the price until it ends — it captured a base price
      // to put back, and editing underneath it would either be silently undone
      // at `endsAt` or would revert to a number nobody chose. Say which sale,
      // and what to do about it, rather than just refusing.
      const running = await activePromotionFor(game.id);
      if (running) {
        throw new AppError(
          409,
          "PROMOTION_ACTIVE",
          "This game is on sale. Change or end the sale instead of setting the price directly.",
          { promotionId: running.id, endsAt: running.endsAt },
        );
      }

      priceChanged = await changePrice(updated, body.priceUnits, req.auth!.id);
      updated = priceChanged.game;

      // The whole return path of a wishlist. Called here rather than inside
      // changePrice so that listing.ts and wishlist.ts don't import each other;
      // this route is the only thing that changes a price. Not awaited — it
      // sends email, and a slow mail server must not hold up a price change
      // that has already happened.
      if (updated.status === "published" && body.priceUnits < game.priceUnits) {
        void notifyPriceDrop(updated, game.priceUnits, body.priceUnits).catch((err) =>
          logger.error({ err, gameId: game.id }, "notifying a price drop failed"),
        );
      }
    } else if (Object.keys(fields).length > 0 && updated.status === "published") {
      // Anything else that changed still belongs on the topic: the listing is
      // the message, so a listing that only changed here is a listing that
      // half-changed.
      await announce(updated, "price_changed", { fromUnits: updated.priceUnits, metadataOnly: true });
    }

    res.json({
      ...updated,
      priceUsd: toDisplayAmount(updated.priceUnits, updated.priceAsset),
      priceAssetDecimals: assetDecimals(updated.priceAsset),
      coverUrl: updated.coverCid ? gatewayUrl(updated.coverCid) : null,
      // False means the change is real here but has not reached the topic yet.
      // Saying so is the point: a developer who lowered a price needs to know
      // whether the agents watching for it can see that.
      announced: priceChanged ? priceChanged.announced : undefined,
    });
  }),
);

// --- builds ----------------------------------------------------------------

const newBuildSchema = z.object({
  label: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
});

gameManageRouter.post(
  "/:id/builds",
  requireAuth,
  upload.fields([{ name: "build", maxCount: 1 }]),
  validate(newBuildSchema),
  asyncHandler(async (req, res) => {
    const game = await requireManageable(param(req, "id"), req.auth!.id);
    const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
    if (!files?.build?.[0]) throw Errors.validationFailed({ build: "a build file is required" });

    const { label, notes } = req.body as z.infer<typeof newBuildSchema>;

    // Same ingest as the first build a game ever had, moderation gate included.
    // A game that passed a check once and could then ship anything afterwards
    // would not be moderated at all.
    const artifacts = await ingestBuild(files.build[0]!.buffer, game.slug);
    const built = await commitBuild(game.id, artifacts, { label, notes });

    const [fresh] = await db.select().from(games).where(eq(games.id, game.id));
    let hcsTxId: string | null = null;
    if (fresh!.status === "published") {
      hcsTxId = await announce(fresh!, "build_updated", { version: built.version, label: label ?? null });
      if (hcsTxId) {
        await db.update(gameBuilds).set({ hcsTxId }).where(eq(gameBuilds.id, built.id));
      }
      await notifyOwnersOfBuild(fresh!, built.version, notes ?? null);
    }

    res.status(201).json({
      version: built.version,
      label: built.label,
      notes: built.notes,
      buildCid: built.buildCid,
      buildSizeKb: built.buildSizeKb,
      hcsTxId,
      createdAt: built.createdAt,
    });
  }),
);

/**
 * Tell everyone holding a key that the game they own changed.
 *
 * Read from the `gameKeys` cache rather than the Mirror Node, and that is
 * fine here specifically because nothing is being granted: this decides who
 * gets a message, not who gets access. Anything that gates access still asks
 * the mirror (services/games/ownership.ts). Doing it the other way would mean
 * a full NFT-holder walk per patch to send some notifications.
 */
async function notifyOwnersOfBuild(game: typeof games.$inferSelect, version: number, notes: string | null) {
  const keys = await db.query.gameKeys.findMany({
    where: and(eq(gameKeys.gameId, game.id), eq(gameKeys.mintStatus, "confirmed")),
    columns: { ownerAccountId: true },
  });
  const accountIds = [...new Set(keys.map((k) => k.ownerAccountId))];
  if (accountIds.length === 0) return;

  const owners = await db.query.users.findMany({
    where: inArray(users.hederaAccountId, accountIds),
    columns: { id: true },
  });
  if (owners.length === 0) return;

  await db.insert(notifications).values(
    owners.map((o) => ({
      userId: o.id,
      type: "build_updated" as const,
      payload: { gameId: game.id, slug: game.slug, title: game.title, version, notes },
    })),
  );
  logger.info({ gameId: game.id, version, owners: owners.length }, "notified owners of a new build");
}

// Public: what versions this game has had, and the CID of each. Provenance is
// only worth anything if a stranger can read it.
gameManageRouter.get(
  "/:id/builds",
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game || game.status === "removed") throw Errors.notFound("Game");
    res.json({ current: game.buildVersion, builds: await listBuilds(game.id) });
  }),
);

// --- price history ---------------------------------------------------------

gameManageRouter.get(
  "/:id/price-history",
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game || game.status === "removed") throw Errors.notFound("Game");

    const history = await priceHistory(game);
    res.json({
      currentUnits: game.priceUnits,
      currentUsd: toDisplayAmount(game.priceUnits, game.priceAsset),
      asset: game.priceAsset,
      assetDecimals: assetDecimals(game.priceAsset),
      // The lowest it has ever been, which is the number a person deciding
      // whether to wait actually wants. Includes the current price, so a game
      // that has never changed still answers honestly.
      lowestEverUnits: history.reduce((low, h) => Math.min(low, h.toUnits), game.priceUnits),
      // Already carries its display pair — see services/games/listing.ts.
      history,
    });
  }),
);

// --- taking it down, and putting it back -----------------------------------

gameManageRouter.post(
  "/:id/unpublish",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await requireManageable(param(req, "id"), req.auth!.id);
    if (game.status !== "published") {
      throw Errors.validationFailed({ status: "only a published game can be unlisted" });
    }

    const [updated] = await db
      .update(games)
      .set({ status: "delisted", delistedBy: "developer", updatedAt: new Date() })
      .where(eq(games.id, game.id))
      .returning();

    await announce(updated!, "delisted", { by: "developer" });

    // Said out loud in the response because it is the question a developer is
    // actually asking when they click this, and the answer is the product's
    // central promise: taking a game off the catalog does not take it off
    // anyone's shelf. There is no wipe key on a GameKey and there never will be.
    res.json({ ...updated, ownersKeepAccess: true });
  }),
);

gameManageRouter.post(
  "/:id/relist",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await requireManageable(param(req, "id"), req.auth!.id);
    if (game.status !== "delisted") {
      throw Errors.validationFailed({ status: "only an unlisted game can be relisted" });
    }
    // A moderation delisting is not the developer's to undo. Without this
    // check, "unlist" and "relist" would be a one-click way around a report.
    if (game.delistedBy !== "developer") {
      throw new AppError(
        409,
        "MODERATION_HOLD",
        "This game was delisted by moderation, so it can't be relisted from here.",
      );
    }

    const [updated] = await db
      .update(games)
      .set({ status: "published", delistedBy: null, updatedAt: new Date() })
      .where(eq(games.id, game.id))
      .returning();

    const hcsTxId = await announce(updated!, "relisted");
    res.json({ ...updated, announced: hcsTxId !== null });
  }),
);

// --- deleting a draft ------------------------------------------------------

gameManageRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await requireManageable(param(req, "id"), req.auth!.id);

    // Only a draft, and only ever a draft. A published game has sold copies,
    // minted keys and a public listing message; deleting the row would leave
    // buyers holding a token that points at nothing. Unlisting is what a
    // developer wants there, and it is the route above.
    if (game.status !== "draft") {
      throw Errors.validationFailed({
        status: "only a draft can be deleted. Unlist a published game instead — its buyers keep their copies.",
      });
    }
    const sold = await db.query.sales.findFirst({ where: eq(sales.gameId, game.id) });
    if (sold) {
      throw new AppError(409, "GAME_HAS_SALES", "This game has sold at least once, so it can't be deleted.");
    }
    // "Watched" is now a want on a wishlist row (agentMaxUnits set), not a
    // dedicated agent row per target — see db/schema.ts#wishlistAgents.
    const watched = await db.query.wishlistItems.findFirst({
      where: and(eq(wishlistItems.gameId, game.id), isNotNull(wishlistItems.agentMaxUnits)),
    });
    if (watched) {
      throw new AppError(409, "GAME_IS_WATCHED", "An agent is watching this game, so it can't be deleted.");
    }

    const media = await db.query.gameMedia.findMany({ where: eq(gameMedia.gameId, game.id) });
    const builds = await db.query.gameBuilds.findMany({ where: eq(gameBuilds.gameId, game.id) });

    // Rows first, in foreign-key order. Storage after, because a failed unpin
    // should not leave an undeletable draft behind — an orphaned pin costs
    // nothing, a row nobody can remove costs a permanent piece of clutter.
    await db.delete(saveStates).where(eq(saveStates.gameId, game.id));
    await db.delete(playSessions).where(eq(playSessions.gameId, game.id));
    await db.delete(likes).where(eq(likes.gameId, game.id));
    await db.delete(comments).where(eq(comments.gameId, game.id));
    await db.delete(reviews).where(eq(reviews.gameId, game.id));
    await db.delete(gameKeys).where(eq(gameKeys.gameId, game.id));
    await db.delete(gamePriceChanges).where(eq(gamePriceChanges.gameId, game.id));
    await db.delete(gameBuilds).where(eq(gameBuilds.gameId, game.id));
    await db.delete(gameMedia).where(eq(gameMedia.gameId, game.id));
    await db.delete(splits).where(eq(splits.gameId, game.id));
    await db.delete(games).where(eq(games.id, game.id));

    await deleteBuild(game.id).catch((err) => logger.warn({ err, gameId: game.id }, "build file not removed"));
    const cids = [
      ...media.map((m) => m.cid),
      ...builds.flatMap((b) => [b.buildCid, b.buildZipCid]),
      game.buildCid,
      game.buildZipCid,
    ].filter((c): c is string => Boolean(c));
    for (const cid of [...new Set(cids)]) {
      await unpinByCid(cid).catch((err) => logger.warn({ err, cid }, "unpinning a draft's file failed"));
    }

    res.json({ deleted: true, id: game.id });
  }),
);

// --- media -----------------------------------------------------------------

gameManageRouter.post(
  "/:id/media",
  requireAuth,
  upload.array("media", 8),
  asyncHandler(async (req, res) => {
    const game = await requireManageable(param(req, "id"), req.auth!.id);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw Errors.validationFailed({ media: "at least one file is required" });

    const csam = await checkImages(files.filter((f) => f.mimetype.startsWith("image/")).map((f) => f.buffer));
    if (!csam.pass) {
      throw new AppError(422, "MODERATION_BLOCKED", "This upload can't be accepted yet.", {
        reason: csam.reason,
      });
    }

    const existing = await db.query.gameMedia.findMany({ where: eq(gameMedia.gameId, game.id) });
    const start = existing.reduce((max, m) => Math.max(max, m.position + 1), 0);

    const cids = await Promise.all(files.map((f) => pinFile(f.buffer, f.originalname, f.mimetype)));
    const rows = await db
      .insert(gameMedia)
      .values(
        cids.map((cid, i) => ({
          gameId: game.id,
          kind: (files[i]!.mimetype.startsWith("video/") ? "video" : "image") as "video" | "image",
          cid,
          position: start + i,
        })),
      )
      .returning();

    await db.update(games).set({ updatedAt: new Date() }).where(eq(games.id, game.id));
    res.status(201).json({ media: rows.map((m) => ({ ...m, url: gatewayUrl(m.cid) })) });
  }),
);

const reorderSchema = z.object({ mediaIds: z.array(z.string().uuid()).min(1).max(32) });

gameManageRouter.patch(
  "/:id/media",
  requireAuth,
  validate(reorderSchema),
  asyncHandler(async (req, res) => {
    const game = await requireManageable(param(req, "id"), req.auth!.id);
    const { mediaIds } = req.body as z.infer<typeof reorderSchema>;

    const existing = await db.query.gameMedia.findMany({ where: eq(gameMedia.gameId, game.id) });
    const owned = new Set(existing.map((m) => m.id));
    if (mediaIds.some((id) => !owned.has(id))) {
      throw Errors.validationFailed({ mediaIds: "one of those images isn't on this game" });
    }

    // Anything left out keeps its relative order after everything named. A
    // reorder that silently dropped the screenshots you didn't mention would
    // be a delete pretending to be a sort.
    let position = 0;
    for (const id of mediaIds) {
      await db.update(gameMedia).set({ position: position++ }).where(eq(gameMedia.id, id));
    }
    for (const m of existing.filter((m) => !mediaIds.includes(m.id)).sort((a, b) => a.position - b.position)) {
      await db.update(gameMedia).set({ position: position++ }).where(eq(gameMedia.id, m.id));
    }

    const rows = await db.query.gameMedia.findMany({
      where: eq(gameMedia.gameId, game.id),
      orderBy: asc(gameMedia.position),
    });
    res.json({ media: rows.map((m) => ({ ...m, url: gatewayUrl(m.cid) })) });
  }),
);

gameManageRouter.delete(
  "/:id/media/:mediaId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await requireManageable(param(req, "id"), req.auth!.id);
    const media = await db.query.gameMedia.findFirst({
      where: and(eq(gameMedia.id, param(req, "mediaId")), eq(gameMedia.gameId, game.id)),
    });
    if (!media) throw Errors.notFound("Image");

    await db.delete(gameMedia).where(eq(gameMedia.id, media.id));
    // The cover pointed at this file, so it has to stop pointing at it. Left
    // alone, the listing would show a broken image that no edit could clear.
    if (game.coverCid === media.cid) {
      await db.update(games).set({ coverCid: null, updatedAt: new Date() }).where(eq(games.id, game.id));
    }
    await unpinByCid(media.cid).catch((err) => logger.warn({ err, cid: media.cid }, "unpin failed"));

    res.json({ deleted: true, id: media.id });
  }),
);

// --- sales ------------------------------------------------------------------
//
// A sale is a *scheduled* price, not a special kind of price. Everything here
// ends up in `changePrice`, so a promotional move produces the same history
// row, the same topic message and the same wishlist notifications a manual one
// does — plus the end date, which is what anything reading the topic needs in
// order to reason about deadlines rather than guess.

const newPromotionSchema = z.object({
  salePriceUnits: z.number().int().nonnegative(),
  // Omit to start now. A scheduled sale is announced when it starts, not when
  // it is created — the topic describes what is on offer, not what is planned.
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime(),
  // Reviving an ended sale points at the old one rather than editing it.
  supersedesId: z.string().uuid().optional(),
});

gameManageRouter.post(
  "/:id/promotions",
  requireAuth,
  validate(newPromotionSchema),
  asyncHandler(async (req, res) => {
    const game = await requireManageable(param(req, "id"), req.auth!.id);
    const body = req.body as z.infer<typeof newPromotionSchema>;

    const promotion = await createPromotion(
      game,
      {
        salePriceUnits: body.salePriceUnits,
        startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
        endsAt: new Date(body.endsAt),
        supersedesId: body.supersedesId ?? null,
      },
      req.auth!.id,
    );

    res.status(201).json(serializePromotion(promotion));
  }),
);

// Public: a game's sale history is price history, and price history here is
// meant to be checkable by someone who doesn't trust us.
gameManageRouter.get(
  "/:id/promotions",
  asyncHandler(async (req, res) => {
    const game = await findGameByRef(param(req, "id"));
    if (!game || game.status === "removed") throw Errors.notFound("Game");
    const active = await activePromotionFor(game.id);
    res.json({
      active: active ? serializePromotion(active) : null,
      history: await promotionHistory(game.id),
    });
  }),
);

const extendSchema = z.object({ endsAt: z.string().datetime() });

gameManageRouter.patch(
  "/:id/promotions/:promotionId",
  requireAuth,
  validate(extendSchema),
  asyncHandler(async (req, res) => {
    const game = await requireManageable(param(req, "id"), req.auth!.id);
    const promotion = await db.query.gamePromotions.findFirst({
      where: and(
        eq(gamePromotions.id, param(req, "promotionId")),
        eq(gamePromotions.gameId, game.id),
      ),
    });
    if (!promotion) throw Errors.notFound("Sale");

    const updated = await extendPromotion(promotion, new Date(req.body.endsAt));
    res.json(serializePromotion(updated));
  }),
);

// Ending a sale early. Announced like any other price change — a deadline that
// was published has to be seen to move.
gameManageRouter.delete(
  "/:id/promotions/:promotionId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await requireManageable(param(req, "id"), req.auth!.id);
    const promotion = await db.query.gamePromotions.findFirst({
      where: and(
        eq(gamePromotions.id, param(req, "promotionId")),
        eq(gamePromotions.gameId, game.id),
      ),
    });
    if (!promotion) throw Errors.notFound("Sale");

    if (promotion.status === "scheduled") {
      // Never started, so there is no price to put back and nothing to announce.
      const [cancelled] = await db
        .update(gamePromotions)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(gamePromotions.id, promotion.id))
        .returning();
      res.json(serializePromotion(cancelled!));
      return;
    }
    if (promotion.status !== "active") {
      throw Errors.validationFailed({ promotionId: "that sale is already over" });
    }

    const ended = await endPromotion(promotion, "cancelled");
    res.json(serializePromotion(ended ?? promotion));
  }),
);

// --- the studio's own view of a game ---------------------------------------

// Everything the manage screen needs in one call: the listing as it stands,
// its build history, its price history, and the numbers that only the team
// sees. Assembled here rather than left as five requests the client has to
// order correctly.
gameManageRouter.get(
  "/:id/manage",
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await requireManageable(param(req, "id"), req.auth!.id);

    const [media, builds, history, gameSales, keys, reviewRows, sessions] = await Promise.all([
      db.query.gameMedia.findMany({ where: eq(gameMedia.gameId, game.id), orderBy: asc(gameMedia.position) }),
      listBuilds(game.id),
      priceHistory(game),
      db.query.sales.findMany({ where: eq(sales.gameId, game.id) }),
      db.query.gameKeys.findMany({
        where: and(eq(gameKeys.gameId, game.id), eq(gameKeys.mintStatus, "confirmed")),
        columns: { ownerAccountId: true },
      }),
      db.query.reviews.findMany({ where: eq(reviews.gameId, game.id), columns: { rating: true } }),
      db.query.playSessions.findMany({
        where: eq(playSessions.gameId, game.id),
        columns: { durationSeconds: true },
      }),
    ]);

    const gross = gameSales.reduce((sum, s) => sum + s.priceUnits, 0);
    const ratings = reviewRows.map((r) => r.rating);

    res.json({
      game: {
        ...game,
        priceUsd: toDisplayAmount(game.priceUnits, game.priceAsset),
        priceAssetDecimals: assetDecimals(game.priceAsset),
        coverUrl: game.coverCid ? gatewayUrl(game.coverCid) : null,
      },
      media: media.map((m) => ({ ...m, url: gatewayUrl(m.cid) })),
      builds,
      priceHistory: history,
      stats: {
        sales: gameSales.length,
        grossUnits: gross,
        grossUsd: toDisplayAmount(gross, game.priceAsset),
        // Distinct wallets holding a key. Higher than `sales` for a free game,
        // which mints keys without ever making a sale row.
        owners: new Set(keys.map((k) => k.ownerAccountId)).size,
        plays: sessions.length,
        playtimeSeconds: sessions.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0),
        reviewCount: ratings.length,
        rating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0,
        // How many people are waiting for it. The number a developer wants
        // before deciding whether a discount is worth running.
        wishlisted: await wishlistCount(game.id),
        // Sales that never reached the collaborators. A team that cannot see
        // this finds out when someone asks where their money is.
        unsettledSplits: gameSales.filter((s) => s.splitStatus !== "distributed").length,
      },
    });
  }),
);

export default gameManageRouter;
