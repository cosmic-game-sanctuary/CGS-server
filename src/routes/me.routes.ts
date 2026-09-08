import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { studios, studioMembers, games, playSessions, users, sales, gameKeys } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { env } from "../config/env.js";
import { resolveHederaAccount } from "../services/users/repo.js";
import { getAccountByEvmAddress, getAllNftsForAccount } from "../services/hedera/mirror.js";
import { assetDecimals, ensFullName, toDisplayAmount } from "../lib/display.js";
import { validate } from "../middleware/validate.middleware.js";
import { Errors } from "../lib/errors.js";
import { consumeWithdrawIntent, prepareWithdraw, submitWithdraw } from "../services/wallet/withdraw.js";
import { settleHeldPayoutsForUser } from "../services/games/fulfil.js";
import { personalEarnings } from "../services/earnings/report.js";
import { wishlistFor } from "../services/games/wishlist.js";
import logger from "../utils/logger.utils.js";
import { fallbackHandle, isReservedHandle, normaliseHandle } from "../lib/handle.js";
import { gatewayUrl, pinFile, unpinByCid } from "../services/ipfs/pinata.js";
import { checkImages } from "../services/moderation/csam.js";
import { AppError } from "../lib/errors.js";

const meRouter = Router({ caseSensitive: true, strict: true });

// The identity endpoint neither login screen nor profile menu had anywhere
// to call: who you are, whether your wallet has a Hedera account yet, its
// current balance in the game asset, and which studio (if any) you own or
// belong to. Nothing here is cached except the hederaAccountId itself
// (through resolveHederaAccount) — balance always asks the Mirror Node fresh,
// since a cached balance is just a wrong balance waiting to happen.
meRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = req.auth!;
    const hadAccount = auth.hederaAccountId !== null;
    const hederaAccountId = await resolveHederaAccount(auth);

    // A safety net, not the primary path any more — settleHeldPayouts pays a
    // known EVM address directly now, account or not (fulfil.ts), so a share
    // is held only for as long as an invite is genuinely unaccepted. This
    // just catches anything from before that was true, or a transient
    // failure at accept-time. Fires once, on the request where the account
    // first resolves, and on a request we were serving anyway.
    if (!hadAccount && hederaAccountId) {
      void settleHeldPayoutsForUser(auth.id, { accountId: hederaAccountId, evmAddress: auth.evmAddress }).catch(
        (err) => logger.error({ err, userId: auth.id }, "auto-settling held payouts failed"),
      );
    }

    let balanceUnits: string | null = null;
    // Tinybars. Reported separately from the settlement asset because it isn't
    // spending money here: the x402 facilitator covers the fee on a purchase
    // and the operator covers it on a withdrawal, so HBAR is only ever what
    // opened the account. A wallet showing 0 USDC and some HBAR is a funded
    // wallet with nothing to spend, and those read identically without this.
    let hbarUnits: string | null = null;
    if (hederaAccountId) {
      const account = await getAccountByEvmAddress(auth.evmAddress);
      const tokenBalance = account?.balance?.tokens.find((t) => t.token_id === env.X402_ASSET);
      balanceUnits = String(tokenBalance?.balance ?? 0);
      hbarUnits = String(account?.balance?.balance ?? 0);
    }

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
          role: "member",
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
      hederaAccountId,
      balanceUnits,
      balanceAsset: env.X402_ASSET,
      // same reasoning as priceUsd on a game: the header renders this and
      // never computes with it, and the decimals it would need to derive one
      // are config that only lives here. See game.routes.ts#toDisplayAmount.
      balanceUsd: balanceUnits === null ? 0 : toDisplayAmount(Number(balanceUnits), env.X402_ASSET),
      balanceAssetDecimals: assetDecimals(env.X402_ASSET),
      hbarUnits,
      hbar: hbarUnits === null ? 0 : toDisplayAmount(Number(hbarUnits), "0.0.0"),
      studio,
      // Every studio this person can act in, owned or joined. `studio` above
      // is whichever of these is primary, kept so existing callers don't move.
      studios: [
        ...(ownedStudio
          ? [{ id: ownedStudio.id, name: ownedStudio.name, slug: ownedStudio.slug, role: "owner" as const }]
          : []),
        ...relatedStudios
          .filter((st) => st.id !== ownedStudio?.id)
          .map((st) => ({ id: st.id, name: st.name, slug: st.slug, role: "member" as const })),
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
    const hederaAccountId = await resolveHederaAccount(auth);
    if (!hederaAccountId) {
      res.json({ games: [] }); // wallet not funded yet -> holds nothing, not an error
      return;
    }

    const nfts = await getAllNftsForAccount(hederaAccountId);
    const tokenIds = [...new Set(nfts.map((n) => n.token_id))];
    if (tokenIds.length === 0) {
      res.json({ games: [] });
      return;
    }

    // `removed` means storage is actually gone — nothing left to play, so it
    // has no place in the library even though the NFT itself still exists.
    // Every other status stays, per "delisting never revokes access."
    const owned = await db.query.games.findMany({
      where: and(inArray(games.htsTokenId, tokenIds), ne(games.status, "removed")),
      with: { studio: true },
    });
    if (owned.length === 0) {
      res.json({ games: [] });
      return;
    }

    const serialByToken = new Map(nfts.map((n) => [n.token_id, n.serial_number]));
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
        serial: g.htsTokenId ? (serialByToken.get(g.htsTokenId) ?? null) : null,
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
    const hederaAccountId = await resolveHederaAccount(auth);
    if (!hederaAccountId) {
      res.json({ purchases: [] });
      return;
    }

    const rows = await db.query.sales.findMany({
      where: eq(sales.buyerAccountId, hederaAccountId),
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
        where: and(eq(gameKeys.ownerAccountId, hederaAccountId), inArray(gameKeys.gameId, gameIds)),
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
// Same two-step shape as a purchase, for the same reason: the server builds and
// freezes the transfer because that needs a Hedera client, and the browser
// signs it because the key belongs to the person, not to us. What differs is
// who pays the network fee — see services/wallet/withdraw.ts.

const withdrawSchema = z.object({
  // Either a Hedera account id or an EVM address. A person copying an address
  // out of their own wallet has no reason to know which one we wanted.
  to: z.string().min(3).max(64),
  asset: z.string().default(env.X402_ASSET),
  // Omit to send the whole balance, which is what "take my money out" usually
  // means and saves the client doing arithmetic on a number it shouldn't.
  amountUnits: z.string().regex(/^\d+$/).optional(),
  // Required by every exchange deposit address, which are pooled accounts that
  // use it to tell whose money arrived. Sending to one without it is the
  // classic way to lose a withdrawal, so it has to be offered.
  memo: z.string().max(100).optional(),
});

meRouter.post(
  "/withdraw/prepare",
  requireAuth,
  validate(withdrawSchema),
  asyncHandler(async (req, res) => {
    const auth = req.auth!;
    const { to, asset, amountUnits, memo } = req.body as z.infer<typeof withdrawSchema>;

    const from = await resolveHederaAccount(auth);
    if (!from) throw Errors.walletNotFunded("There is nothing in this wallet to withdraw yet.");

    const toAccountId = await resolveDestination(to);
    if (!toAccountId) {
      throw Errors.validationFailed({
        to: "No Hedera account was found for that address. Check it, or send it some HBAR first so it exists.",
      });
    }
    if (toAccountId === from) {
      throw Errors.validationFailed({ to: "That is this wallet. Send it somewhere else." });
    }

    const account = await getAccountByEvmAddress(auth.evmAddress);
    const available =
      asset === "0.0.0"
        ? (account?.balance?.balance ?? 0)
        : (account?.balance?.tokens.find((t) => t.token_id === asset)?.balance ?? 0);

    const amount = amountUnits === undefined ? BigInt(available) : BigInt(amountUnits);
    if (amount <= 0n) throw Errors.validationFailed({ amountUnits: "There is nothing to send." });
    if (amount > BigInt(available)) {
      throw Errors.validationFailed({
        amountUnits: `That is more than this wallet holds (${available}).`,
      });
    }

    const intent = await prepareWithdraw({
      userId: auth.id,
      evmAddress: auth.evmAddress,
      fromAccountId: from,
      toAccountId,
      asset,
      amountUnits: amount,
      memo,
    });

    res.json({
      intentId: intent.id,
      hashes: intent.hashes,
      to: toAccountId,
      asset,
      amountUnits: intent.amountUnits,
      memo: intent.memo,
      amountDisplay: toDisplayAmount(Number(intent.amountUnits), asset),
      assetDecimals: assetDecimals(asset),
      expiresAt: new Date(intent.expiresAt).toISOString(),
    });
  }),
);

const completeSchema = z.object({
  intentId: z.string().uuid(),
  signatures: z
    .array(z.object({ hash: z.string().min(3), signature: z.string().min(3) }))
    .min(1),
});

meRouter.post(
  "/withdraw/complete",
  requireAuth,
  validate(completeSchema),
  asyncHandler(async (req, res) => {
    const { intentId, signatures } = req.body as z.infer<typeof completeSchema>;

    const intent = consumeWithdrawIntent(intentId, req.auth!.id);
    if (!intent) {
      throw Errors.validationFailed({
        intentId: "That withdrawal expired or was already used. Start it again.",
      });
    }

    try {
      const transactionId = await submitWithdraw(intent, signatures);
      res.json({
        status: "sent",
        transactionId,
        to: intent.toAccountId,
        asset: intent.asset,
        amountUnits: intent.amountUnits,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, intentId }, "withdrawal failed");
      // TOKEN_NOT_ASSOCIATED_TO_ACCOUNT is the one a person can actually act
      // on, and the raw status says nothing about what to do next.
      if (message.includes("TOKEN_NOT_ASSOCIATED_TO_ACCOUNT")) {
        throw Errors.validationFailed({
          to: "That account cannot receive this token yet. Associate it in your wallet, then try again.",
        });
      }
      throw Errors.validationFailed({ intentId: message });
    }
  }),
);

/** A Hedera account id as given, or the account behind an EVM address. */
async function resolveDestination(input: string): Promise<string | null> {
  const value = input.trim();
  if (/^\d+\.\d+\.\d+$/.test(value)) return value;
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) return null;
  const account = await getAccountByEvmAddress(value);
  return account?.account ?? null;
}

export default meRouter;
