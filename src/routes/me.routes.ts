import { Router } from "express";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { studios, studioMembers, games, playSessions } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { env } from "../config/env.js";
import { resolveHederaAccount } from "../services/users/repo.js";
import { getAccountByEvmAddress, getAllNftsForAccount } from "../services/hedera/mirror.js";
import { assetDecimals, ensFullName, toDisplayAmount } from "../lib/display.js";
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
    if (hederaAccountId) {
      const account = await getAccountByEvmAddress(auth.evmAddress);
      const tokenBalance = account?.balance?.tokens.find((t) => t.token_id === env.X402_ASSET);
      balanceUnits = String(tokenBalance?.balance ?? 0);
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

export default meRouter;
