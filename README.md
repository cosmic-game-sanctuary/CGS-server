# CGS-server

Backend for [Cosmic Game Sanctuary](https://github.com/cosmic-game-sanctuary/CGS-docs) — a storefront for browser-playable indie games where payment and ownership settle on Hedera, so no payment processor decides what's sellable and no company decides what a buyer keeps owning. Built for ETHOnline 2026.

This repo is the API, the chain integration, and the wishlist agent. The storefront itself is [CGS-client](https://github.com/cosmic-game-sanctuary/CGS-client).

## Three claims a judge can check directly, not just read

**GameKey tokens carry no wipe, freeze, or pause key.** See `createGameToken` in [`src/services/hedera/hts.ts`](src/services/hedera/hts.ts). We're structurally unable to take a purchase back — check any minted token on [HashScan](https://hashscan.io/testnet) rather than take our word for it.

**Delisting doesn't revoke access.** A delisted game leaves the catalog but stays playable for anyone already holding a key — see the state machine in [`src/db/schema.ts`](src/db/schema.ts) and the download branch in [`src/routes/game.routes.ts`](src/routes/game.routes.ts). Only `removed` (genuinely illegal content, resolved by a human, never an endpoint a studio can hit itself) unpins from storage.

**The wishlist agent reads the public HCS topic, not our database.** See [`src/agent/watcher.ts`](src/agent/watcher.ts) — it polls the Mirror Node the same way any outside program could, because that's the point. It has its own wallet, its own on-chain identity (HCS-14), and its balance is its entire spending cap. Nothing else limits it, because nothing else needs to.

## Stack

Node + TypeScript (ESM) · Express · Postgres via [Drizzle](https://orm.drizzle.team/) · [`@hiero-ledger/sdk`](https://github.com/hiero-ledger/hiero-sdk-js) for Hedera · [x402](https://x402.org) (`@x402/core` + `@x402/express` + `@x402/hedera`) through the Blocky402 facilitator for payment · [`@privy-io/node`](https://docs.privy.io/) for wallets, auth, and agent signing · [ENSv2](https://docs.ens.domains/) on Sepolia via [viem](https://viem.sh/) for studio names · [Pinata](https://docs.pinata.cloud/) for IPFS.

Almost none of this is Hedera-specific once you're past the surface. Routing, validation, auth, uploads, invites, and notifications are a normal Express + Drizzle app that happens to call into five files — `services/hedera/{client,mirror,hcs,hts}.ts` and `services/x402/server.ts` — at specific points. The rest reads like any other REST backend.

## Running it locally

```bash
npm install
cp .env.example .env   # fill in the real values — see below
npm run db:migrate      # applies drizzle/ against DATABASE_URL
npm run dev             # tsx watch src/index.ts, on :3000
curl localhost:3000/health
```

`.env.example` documents every variable inline, grouped by what it's for: server config, Neon Postgres (two connection strings — direct for migrations, pooled for the running app, because PgBouncer's transaction mode doesn't support the `SET` statements a migration issues), Hedera (a funded testnet operator account from [portal.hedera.com](https://portal.hedera.com)), x402/Blocky402, HCS topic IDs, Privy, ENSv2/Sepolia, Pinata, and the CSAM moderation gate.

**Every upload fails closed with `MODERATION_BLOCKED` until a CSAM-scanning provider is chosen.** That's deliberate, not a bug — see `CSAM_MODE` in `.env.example` and `checkImages()` in [`src/services/moderation/csam.ts`](src/services/moderation/csam.ts). The rest of the pipeline (unzip, splits validation, IPFS pinning) is real and testable with `CSAM_MODE=skip` locally; it stays `block` everywhere else.

## API

Full endpoint list and request/response shapes, written for whoever's wiring a client against this: [`CGS-docs/INTEGRATION.md`](https://github.com/cosmic-game-sanctuary/CGS-docs/blob/main/INTEGRATION.md). Short version — everything is ordinary REST with one exception:

```http
GET /api/games/:id/download
```

Returns `200` immediately for a free game or one this wallet already owns. Otherwise it's the [x402](https://x402.org) flow: a `402` with payment terms, a signed payment on retry, verify and settle through Blocky402, then `200` with a playable URL. `POST /api/games/:id/pay` is the same path server-signed, for a logged-in buyer whose browser can't hold a signing key.

Auth is a Privy access token as `Authorization: Bearer <token>` — no cookies, no sessions, no CSRF surface. Browsing (catalog, listings, reviews, studio pages) never requires one.

## What's deliberately not here

No resale or secondary market, no refunds, no editing revenue splits after a game publishes, no biometric or identity verification on upload, no admin override on anything moderation touches. Each of these was cut on purpose — see [`CGS-docs/README.md`](https://github.com/cosmic-game-sanctuary/CGS-docs) for why. A stale comment or an old doc that still gestures at one of these is a bug to flag, not a feature to finish.

## Status

Every numbered build stage is done and was tested against real infrastructure at each step — live Neon, live Hedera testnet, the live Blocky402 facilitator, live Sepolia, live Pinata — not mocks. Full history, one entry per session, is in [`CGS-docs/PROGRESS-LOG.md`](https://github.com/cosmic-game-sanctuary/CGS-docs/blob/main/PROGRESS-LOG.md).
