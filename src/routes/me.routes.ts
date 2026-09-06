import { Router } from "express";
import { z } from "zod";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { studios, studioMembers, games, playSessions } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { env } from "../config/env.js";
import { resolveHederaAccount } from "../services/users/repo.js";
import { getAccountByEvmAddress, getAllNftsForAccount } from "../services/hedera/mirror.js";
import { assetDecimals, ensFullName, toDisplayAmount } from "../lib/display.js";
import { validate } from "../middleware/validate.middleware.js";
import { Errors } from "../lib/errors.js";
import { consumeWithdrawIntent, prepareWithdraw, submitWithdraw } from "../services/wallet/withdraw.js";
import logger from "../utils/logger.utils.js";
import { fallbackHandle } from "../lib/handle.js";
import { gatewayUrl } from "../services/ipfs/pinata.js";

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
    const hederaAccountId = await resolveHederaAccount(auth);

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

    const membership = await db.query.studioMembers.findFirst({
      where: and(eq(studioMembers.userId, auth.id), isNotNull(studioMembers.acceptedAt)),
    });

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

    res.json({
      id: auth.id,
      email: auth.email,
      evmAddress: auth.evmAddress,
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
});

meRouter.post(
  "/withdraw/prepare",
  requireAuth,
  validate(withdrawSchema),
  asyncHandler(async (req, res) => {
    const auth = req.auth!;
    const { to, asset, amountUnits } = req.body as z.infer<typeof withdrawSchema>;

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
    });

    res.json({
      intentId: intent.id,
      hashes: intent.hashes,
      to: toAccountId,
      asset,
      amountUnits: intent.amountUnits,
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
