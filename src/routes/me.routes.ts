import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { studios, studioMembers, games, playSessions, users, sales, gameKeys } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { env } from "../config/env.js";
import { getUsdcUnits } from "../services/arc/reads.js";
import { keysHeldBy } from "../services/arc/keys.js";
import { uuidFromGameId } from "../services/arc/registry.js";
import { assetDecimals, ensFullName, toDisplayAmount } from "../lib/display.js";
import { validate } from "../middleware/validate.middleware.js";
import { Errors } from "../lib/errors.js";
import {
  confirmWithdraw,
  consumeWithdrawIntent,
  prepareWithdraw,
  transactionFor,
  USDC_ADDRESS,
} from "../services/wallet/withdraw.js";
import { settleHeldPayoutsForUser } from "../services/games/fulfil.js";
import { personalEarnings } from "../services/earnings/report.js";
import { wishlistFor } from "../services/games/wishlist.js";
import logger from "../utils/logger.utils.js";
import { fallbackHandle, isReservedHandle, normaliseHandle } from "../lib/handle.js";
import { gatewayUrl, pinFile, unpinByCid } from "../services/ipfs/pinata.js";
import { checkImages } from "../services/moderation/csam.js";
import { AppError } from "../lib/errors.js";

const meRouter = Router({ caseSensitive: true, strict: true });

// The identity endpoint neither login screen nor profile menu had anywhere to
// call: who you are, your wallet's current balance, and which studio (if any)
// you own or belong to.
//
// Simpler on Arc in two ways. There is no "does this wallet have an account
// yet" state — an address is live from the moment it exists — and there is no
// second asset to report, because the gas token and the money are the same
// token. Nothing here is cached: a cached balance is a wrong balance waiting to
// happen, so it is always read fresh from the chain.
meRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = req.auth!;

    // Atomic USDC units, 6dp — the same unit a price is quoted in. There is no
    // separate gas balance to report: on Arc the fee is paid in this.
    const balanceUnits = String(await getUsdcUnits(auth.evmAddress as `0x${string}`));

    const ownedStudio = await db.query.studios.findFirst({ where: eq(studios.ownerUserId, auth.id) });

    // Someone can be on several teams — inviting a collaborator by email is
    // exactly what produces that — and returning one of them arbitrarily hid
    // the others. `studio` below stays the primary so nothing breaks; this is
    // the full list beside it.
    // Active only — someone who left a studio, or was removed from one, should
    // stop seeing it here even though every credit they earned on it stays
    // exactly where it is, in `splits`.
    const allMemberships = await db.query.studioMembers.findMany({
      where: and(
        eq(studioMembers.userId, auth.id),
        isNotNull(studioMembers.acceptedAt),
        eq(studioMembers.active, true),
      ),
    });
    const memberStudioIds = allMemberships.map((m) => m.studioId);
    // The role on the row, not a constant. `studio.role` and every entry in
    // `studios[]` used to be hardcoded "owner" for the studio you founded and
    // "member" for everything else, which made a promotion invisible: the one
    // client check that reads this (`role === 'owner'` for "can manage") could
    // never be true for a manager, so promoting someone changed nothing they
    // could see or do. See services/studios/access.ts#canManageStudio, which
    // is the rule this field is supposed to mirror.
    const roleByStudio = new Map(allMemberships.map((m) => [m.studioId, m.role]));
    const relatedStudios = memberStudioIds.length
      ? await db.query.studios.findMany({ where: inArray(studios.id, memberStudioIds) })
      : [];

    // `handle` is what appears on a split and in the studio credits, so the
    // publish flow needs it before it can put you on your own game's splits.
    // It lives on the membership row, which every studio owner now gets at
    // creation — `fallbackHandle` covers studios made before that was true.
    let studio: {
      id: string;
      name: string;
      slug: string;
      role: "owner" | "member";
      handle: string;
    } | null = null;

    const membership = allMemberships[0];

    if (ownedStudio) {
      const ownRow =
        membership?.studioId === ownedStudio.id
          ? membership
          : await db.query.studioMembers.findFirst({
              where: and(eq(studioMembers.studioId, ownedStudio.id), eq(studioMembers.userId, auth.id)),
            });
      studio = {
        id: ownedStudio.id,
        name: ownedStudio.name,
        slug: ownedStudio.slug,
        role: "owner",
        handle: ownRow?.handle ?? fallbackHandle(auth.email),
      };
    } else if (membership) {
      const memberStudio = await db.query.studios.findFirst({ where: eq(studios.id, membership.studioId) });
      if (memberStudio) {
        studio = {
          id: memberStudio.id,
          name: memberStudio.name,
          slug: memberStudio.slug,
          role: membership.role,
          handle: membership.handle,
        };
      }
    }

    // The profile fields, so the header can render a name and an avatar without
    // a second request, and so a client knows the URL of this person's own page.
    const me = await db.query.users.findFirst({ where: eq(users.id, auth.id) });

    res.json({
      id: auth.id,
      email: auth.email,
      evmAddress: auth.evmAddress,
      handle: me?.handle ?? null,
      displayName: me?.displayName ?? null,
      label: me?.displayName || me?.handle || auth.email,
      bio: me?.bio ?? null,
      avatarCid: me?.avatarCid ?? null,
      avatarUrl: me?.avatarCid ? gatewayUrl(me.avatarCid) : null,
      libraryPublic: me?.libraryPublic ?? true,
      balanceUnits,
      balanceAsset: USDC_ADDRESS,
      // Same reasoning as priceUsd on a game: the header renders this and never
      // computes with it, and the decimals it would need are config that only
      // lives here. See game.routes.ts#toDisplayAmount.
      balanceUsd: toDisplayAmount(Number(balanceUnits), USDC_ADDRESS),
      balanceAssetDecimals: 6,
      studio,
      // Every studio this person can act in, owned or joined. `studio` above
      // is whichever of these is primary, kept so existing callers don't move.
      studios: [
        ...(ownedStudio
          ? [{ id: ownedStudio.id, name: ownedStudio.name, slug: ownedStudio.slug, role: "owner" as const }]
          : []),
        ...relatedStudios
          .filter((st) => st.id !== ownedStudio?.id)
          .map((st) => ({
            id: st.id,
            name: st.name,
            slug: st.slug,
            role: roleByStudio.get(st.id) ?? ("member" as const),
          })),
      ],
    });
  }),
);

// Every game this wallet actually holds a key for, checked live against the
// Mirror Node — never the local gameKeys cache table, same rule as
// services/games/ownership.ts. A per-game owned check already existed
// (GET /api/games/:id/owned); this is the bulk version /library actually
// needs, and it costs exactly one Mirror Node call (every NFT this account
// holds, across every token) plus one DB query, not one Mirror call per game.
meRouter.get(
  "/library",
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = req.auth!;

    // One call for the whole library: every key this wallet holds, each naming
    // the game it belongs to. The Hedera version walked paginated NFT lists and
    // then matched token ids back to games; here the key carries the game id.
    const keys = await keysHeldBy(auth.evmAddress as `0x${string}`);
    if (keys.length === 0) {
      res.json({ games: [] });
      return;
    }

    const gameUuids = keys
      .map((k) => uuidFromGameId(k.gameId))
      .filter((id): id is string => id !== null);
    if (gameUuids.length === 0) {
      res.json({ games: [] });
      return;
    }

    // `removed` means storage is actually gone — nothing left to play, so it has
    // no place in the library even though the key itself still exists. Every
    // other status stays, per "delisting never revokes access."
    const owned = await db.query.games.findMany({
      where: and(inArray(games.id, gameUuids), ne(games.status, "removed")),
      with: { studio: true },
    });
    if (owned.length === 0) {
      res.json({ games: [] });
      return;
    }

    const serialByGame = new Map(
      keys.flatMap((k) => {
        const uuid = uuidFromGameId(k.gameId);
        return uuid ? [[uuid, Number(k.tokenId)] as const] : [];
      }),
    );
    const gameIds = owned.map((g) => g.id);

    const sessions = await db.query.playSessions.findMany({
      where: and(eq(playSessions.userId, auth.id), inArray(playSessions.gameId, gameIds)),
      columns: { gameId: true, durationSeconds: true },
    });
    const statsByGame = new Map<string, { playCount: number; playtimeSeconds: number }>();
    for (const s of sessions) {
      const cur = statsByGame.get(s.gameId) ?? { playCount: 0, playtimeSeconds: 0 };
      cur.playCount += 1;
      cur.playtimeSeconds += s.durationSeconds ?? 0;
      statsByGame.set(s.gameId, cur);
    }

    res.json({
      games: owned.map((g) => ({
        id: g.id,
        slug: g.slug,
        title: g.title,
        tagline: g.tagline,
        studio: { id: g.studio.id, name: g.studio.name, ens: ensFullName(g.studio.ensSubname), slug: g.studio.slug },
        coverCid: g.coverCid,
        coverUrl: g.coverCid ? gatewayUrl(g.coverCid) : null,
        coverSeed: g.coverSeed,
        status: g.status,
        serial: serialByGame.get(g.id) ?? null,
        myPlayCount: statsByGame.get(g.id)?.playCount ?? 0,
        myPlaytimeSeconds: statsByGame.get(g.id)?.playtimeSeconds ?? 0,
      })),
    });
  }),
);

// The list a wishlist exists to produce: what you saved, what it costs now, and
// what has changed since. Ordered newest first.
meRouter.get(
  "/wishlist",
  requireAuth,
  asyncHandler(async (req, res) => {
    const items = await wishlistFor(req.auth!.id);
    res.json({
      items,
      // Surfaced separately because it is the number a "3 games on your list
      // are cheaper" banner needs, and counting client-side means every client
      // reimplements the same comparison.
      onSale: items.filter((i) => i.percentOff > 0).length,
    });
  }),
);

meRouter.get(
  "/earnings",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await personalEarnings(req.auth!.id));
  }),
);

// --- your own profile ------------------------------------------------------

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  // An avatar is a small image. The 200MB ceiling the build upload needs would
  // be an invitation here.
  limits: { fileSize: 5 * 1024 * 1024 },
});

const editProfileSchema = z
  .object({
    displayName: z.string().max(60).nullable().optional(),
    bio: z.string().max(500).nullable().optional(),
    handle: z.string().min(2).max(30).optional(),
    libraryPublic: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "nothing to change" });

meRouter.patch(
  "/profile",
  requireAuth,
  validate(editProfileSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof editProfileSchema>;
    const fields: Partial<typeof users.$inferInsert> = {};

    if (body.displayName !== undefined) fields.displayName = body.displayName?.trim() || null;
    if (body.bio !== undefined) fields.bio = body.bio?.trim() || null;
    if (body.libraryPublic !== undefined) fields.libraryPublic = body.libraryPublic;

    if (body.handle !== undefined) {
      // Normalised rather than rejected, because "Kai Saha" is a reasonable
      // thing to type into a field labelled "handle" and turning it into
      // "kaisaha" is more useful than an error. What it became comes back in
      // the response so nobody is surprised by their own URL.
      const handle = normaliseHandle(body.handle);
      if (!handle) {
        throw Errors.validationFailed({ handle: "Use letters, numbers, dots, dashes or underscores." });
      }
      if (isReservedHandle(handle)) {
        throw Errors.validationFailed({ handle: `"${handle}" is reserved.` });
      }
      const taken = await db.query.users.findFirst({ where: eq(users.handle, handle), columns: { id: true } });
      if (taken && taken.id !== req.auth!.id) {
        // A collision belongs to the person choosing, so they are told rather
        // than quietly handed a numbered variant of the name they wanted.
        throw new AppError(409, "HANDLE_TAKEN", `"${handle}" is already taken.`);
      }
      fields.handle = handle;
    }

    const [updated] = await db.update(users).set(fields).where(eq(users.id, req.auth!.id)).returning();
    res.json({
      handle: updated!.handle,
      displayName: updated!.displayName,
      bio: updated!.bio,
      libraryPublic: updated!.libraryPublic,
      avatarUrl: updated!.avatarCid ? gatewayUrl(updated!.avatarCid) : null,
    });
  }),
);

meRouter.post(
  "/avatar",
  requireAuth,
  avatarUpload.single("avatar"),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw Errors.validationFailed({ avatar: "an image file is required" });
    if (!file.mimetype.startsWith("image/")) {
      throw Errors.validationFailed({ avatar: "that isn't an image" });
    }

    // The same gate every other uploaded image goes through. An avatar is the
    // one image on the site that appears next to a person's words everywhere,
    // which makes skipping the check here worse, not more acceptable.
    const csam = await checkImages([file.buffer]);
    if (!csam.pass) {
      throw new AppError(422, "MODERATION_BLOCKED", "This image can't be accepted.", { reason: csam.reason });
    }

    const previous = (await db.query.users.findFirst({ where: eq(users.id, req.auth!.id) }))?.avatarCid ?? null;
    const cid = await pinFile(file.buffer, file.originalname || "avatar", file.mimetype);
    await db.update(users).set({ avatarCid: cid }).where(eq(users.id, req.auth!.id));

    // Replaced, so the old one has nothing pointing at it. Failing to unpin is
    // not worth failing the request over — an orphaned pin costs storage, a
    // failed avatar change costs the person their afternoon.
    if (previous && previous !== cid) {
      void unpinByCid(previous).catch((err) => logger.warn({ err, cid: previous }, "unpinning an old avatar failed"));
    }

    res.json({ avatarCid: cid, avatarUrl: gatewayUrl(cid) });
  }),
);

meRouter.delete(
  "/avatar",
  requireAuth,
  asyncHandler(async (req, res) => {
    const current = (await db.query.users.findFirst({ where: eq(users.id, req.auth!.id) }))?.avatarCid ?? null;
    await db.update(users).set({ avatarCid: null }).where(eq(users.id, req.auth!.id));
    if (current) {
      void unpinByCid(current).catch((err) => logger.warn({ err, cid: current }, "unpinning an avatar failed"));
    }
    res.json({ avatarCid: null, avatarUrl: null });
  }),
);

// --- receipts --------------------------------------------------------------

// Every purchase this wallet has made, with the settlement transaction behind
// it. `sales` has recorded all of this since Stage 4 and nothing ever showed a
// buyer their own — so the one storefront where every payment is a public,
// checkable transaction was also the one that couldn't produce a receipt.
meRouter.get(
  "/purchases",
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = req.auth!;

    const rows = await db.query.sales.findMany({
      where: sql`lower(${sales.buyerAccountId}) = ${auth.evmAddress.toLowerCase()}`,
      orderBy: desc(sales.createdAt),
    });
    if (rows.length === 0) {
      res.json({ purchases: [] });
      return;
    }

    const gameIds = [...new Set(rows.map((r) => r.gameId))];
    const [gameRows, keys] = await Promise.all([
      db.query.games.findMany({ where: inArray(games.id, gameIds), with: { studio: true } }),
      db.query.gameKeys.findMany({
        where: and(
          sql`lower(${gameKeys.ownerAccountId}) = ${auth.evmAddress.toLowerCase()}`,
          inArray(gameKeys.gameId, gameIds),
        ),
        columns: { gameId: true, tokenId: true, serial: true },
      }),
    ]);
    const gameById = new Map(gameRows.map((g) => [g.id, g]));
    const keyByGame = new Map(keys.map((k) => [k.gameId, k]));

    res.json({
      purchases: rows.map((r) => {
        const game = gameById.get(r.gameId);
        const key = keyByGame.get(r.gameId);
        return {
          id: r.id,
          at: r.createdAt,
          priceUnits: r.priceUnits,
          priceAsset: r.priceAsset,
          priceUsd: toDisplayAmount(r.priceUnits, r.priceAsset),
          assetDecimals: assetDecimals(r.priceAsset),
          // What makes this a receipt rather than a line in our database: the
          // buyer can look it up on the Mirror Node themselves.
          settlementTxId: r.settlementTxId,
          hcsSaleTxId: r.hcsSaleTxId,
          game: game
            ? {
                id: game.id,
                slug: game.slug,
                title: game.title,
                coverCid: game.coverCid,
                coverUrl: game.coverCid ? gatewayUrl(game.coverCid) : null,
                coverSeed: game.coverSeed,
                status: game.status,
                studio: { id: game.studio.id, name: game.studio.name, slug: game.studio.slug },
              }
            : null,
          key: key ? { tokenId: key.tokenId, serial: key.serial } : null,
        };
      }),
    });
  }),
);

// --- withdrawing -----------------------------------------------------------
//
// Much smaller than it was, and the shrinkage is the point. On Hedera the server
// had to build, freeze and submit the transfer so the *operator* could pay the
// network fee — a wallet holding only USDC and no HBAR could not otherwise be
// emptied. On Arc the fee is paid in USDC, the same asset being withdrawn, so a
// wallet with money in it can always afford to move that money and the server
// has no reason to stand in the middle.
//
// What is left: we validate and hand back the transaction, the browser sends it
// with the owner's own key, and we confirm it from the chain. See
// services/wallet/withdraw.ts.
//
// A developer's share of sales is not withdrawn here at all — it accrues in the
// game's SplitVault and they call `claim()` on it themselves.

const withdrawSchema = z.object({
  to: z.string().min(3).max(64),
  // Omit to send everything the wallet can afford to send, which is what "take
  // my money out" usually means. A little is held back for the fee.
  amountUnits: z.string().regex(/^\d+$/).optional(),
});

meRouter.post(
  "/withdraw/prepare",
  requireAuth,
  validate(withdrawSchema),
  asyncHandler(async (req, res) => {
    const auth = req.auth!;
    const { to, amountUnits } = req.body as z.infer<typeof withdrawSchema>;

    const intent = await prepareWithdraw({
      userId: auth.id,
      from: auth.evmAddress as `0x${string}`,
      to,
      amountUnits: amountUnits === undefined ? undefined : BigInt(amountUnits),
    });

    res.json({
      intentId: intent.id,
      to: intent.to,
      asset: USDC_ADDRESS,
      amountUnits: intent.amountUnits.toString(),
      amountDisplay: toDisplayAmount(Number(intent.amountUnits), USDC_ADDRESS),
      assetDecimals: 6,
      reservedForGasUnits: intent.reservedForGasUnits.toString(),
      // Send this from the owner's wallet. `value` is native 18-decimal wei,
      // which is what a wallet expects — USDC is the native token here.
      transaction: transactionFor(intent),
      expiresAt: new Date(intent.expiresAt).toISOString(),
    });
  }),
);

const completeSchema = z.object({
  intentId: z.string().uuid(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a transaction hash"),
});

meRouter.post(
  "/withdraw/complete",
  requireAuth,
  validate(completeSchema),
  asyncHandler(async (req, res) => {
    const { intentId, txHash } = req.body as z.infer<typeof completeSchema>;

    const intent = consumeWithdrawIntent(intentId, req.auth!.id);
    if (!intent) {
      throw Errors.validationFailed({
        intentId: "That withdrawal expired or was already used. Start it again.",
      });
    }

    // Confirmed against the chain, never taken on the client's word: this is a
    // receipt for something that already happened.
    const confirmed = await confirmWithdraw(intent, txHash as `0x${string}`);
    res.json({
      status: "sent",
      transactionId: confirmed.txHash,
      to: confirmed.to,
      asset: USDC_ADDRESS,
      amountUnits: confirmed.amountUnits.toString(),
    });
  }),
);


export default meRouter;
