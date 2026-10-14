# CGS-server

The API, the chain integration, and the buying agent for
**[Cosmic Game Sanctuary](https://github.com/cosmic-game-sanctuary/CGS-docs)**, an indie game store where an autonomous agent buys on your behalf, revenue splits are enforced by a contract that pays a whole team without the money ever touching us, and trials are metered by the minute over x402. It runs on [Arc](https://www.arc.io/), Circle's EVM L1 where USDC is the gas token, so no card network decides what's sellable and no company decides what a buyer keeps owning.

🟢 **Live on Arc mainnet:** [cgs.blackslate.me](https://cgs.blackslate.me) · 🧪 **Testnet:** [testnet.cgs.blackslate.me](https://testnet.cgs.blackslate.me)

📺 **[Demo](VIDEO_LINK)** · 📖 [How it all works](https://github.com/cosmic-game-sanctuary/CGS-docs/blob/main/ARCHITECTURE.md) · 🔌 [API contract](https://github.com/cosmic-game-sanctuary/CGS-docs/blob/main/INTEGRATION.md)

Built for the Arc Microgrants program. The storefront is [CGS-client](https://github.com/cosmic-game-sanctuary/CGS-client) and the contracts are in [CGS-contracts](https://github.com/cosmic-game-sanctuary/CGS-contracts).

## Claims a judge can check directly, not just read

**Splits cannot change after publish.** Each game gets its own `SplitVault`, deployed through `VaultFactory` at publish with every payee's share and the platform's 5% fixed in its constructor. The vault has no owner and no setter. See [`src/services/arc/vault.ts`](src/services/arc/vault.ts) and the contract source on the explorer.

**GameKey has no admin.** Ownership is an ERC-721 with no pause, burn or freeze function, so delisting a game cannot take a key back and neither can we. A delisted game leaves the catalog but stays playable for anyone holding a key; see the download branch in [`src/routes/game.routes.ts`](src/routes/game.routes.ts).

**The agent reads the public chain, not our database.** [`src/agent/watcher.ts`](src/agent/watcher.ts) polls `GameRegistry` events with `eth_getLogs`, the same way any outside program could. It has its own wallet and ERC-8004 identity, and its per-purchase ceiling is published on chain and enforced where the authorization is signed.

**A purchase never passes through us.** The 402 challenge names the game's vault as `payTo`. The buyer signs an EIP-3009 authorization in their own browser wallet, and Circle's facilitator settles it and pays the gas. Trial chunks are the one exception, held briefly by the operator before a relay forwards them to the vault; see [`src/services/arc/x402/trialRelay.ts`](src/services/arc/x402/trialRelay.ts).

## Stack

Node + TypeScript (ESM) · Express · Postgres via [Drizzle](https://orm.drizzle.team/) · [viem](https://viem.sh/) for Arc · Circle's Facilitator and [Gateway nanopayments](https://developers.circle.com/gateway-nanopayments) over [x402](https://x402.org) · [`@privy-io/node`](https://docs.privy.io/) for wallets, auth, and agent signing · [ENSv2](https://docs.ens.domains/) on Sepolia for studio and agent names · [Pinata](https://docs.pinata.cloud/) for IPFS · Groq for the agent's contested decisions.

The chain layer lives in `src/services/arc/` (client, registry, vault, factory, keys, x402). Routing, validation, auth, uploads, invites, and notifications are an ordinary Express + Drizzle app that calls into it at specific points.

## Running it locally

```bash
npm install
cp .env.example .env   # fill in the real values, see below
npm run db:migrate      # applies drizzle/ against DATABASE_URL
npm run dev             # tsx watch src/index.ts, on :3000
curl localhost:3000/health
```

`.env.example` documents every variable inline: server config, Neon Postgres (two connection strings, direct for migrations and pooled for the running app, because PgBouncer's transaction mode doesn't support the `SET` statements a migration issues), Arc (network, RPC, operator key, the deployed contract addresses, platform payout), Circle's API key, Privy, ENSv2/Sepolia, Pinata, and the CSAM moderation gate.

**Testnet vs mainnet is one switch, `ARC_NETWORK`.** Use a separate database and a separate operator for each. To run against mainnet locally without touching your testnet `.env`, keep the values in `.env.mainnet` and start with `DOTENV_CONFIG_PATH=.env.mainnet`.

The testnet deployment can also run a public, capped faucet (`TESTNET_FAUCET=on`) so anyone can try the app with free test USDC. The server refuses to boot with it on mainnet.

**Uploads follow `CSAM_MODE`.** With no scanning provider wired, `block` fails every upload closed with `MODERATION_BLOCKED`, which is deliberate; see `checkImages()` in [`src/services/moderation/csam.ts`](src/services/moderation/csam.ts), the single seam a provider drops into.

## Tests

Acceptance scripts run against a real chain and a real database, not mocks, e.g. `npm run arc:check:publish`, `arc:check:agent`, `arc:check:contested`, `arc:check:trial-relay`, `arc:check:gateway:withdraw`. They are listed in `package.json` and need a funded testnet operator.

## API

Full endpoint list and request/response shapes: [`CGS-docs/INTEGRATION.md`](https://github.com/cosmic-game-sanctuary/CGS-docs/blob/main/INTEGRATION.md). Everything is ordinary REST with one exception:

```http
GET /api/games/:id/download
```

Returns `200` immediately for a free game or one this wallet already owns. Otherwise it's the [x402](https://x402.org) flow: a `402` with payment terms (`payTo` is the game's vault), a signed authorization on retry, settlement through Circle's facilitator, then `200` with a playable URL. `POST /api/games/:id/pay/prepare` + `POST /api/games/:id/pay/complete` is the same settlement split in two for clients that sign separately.

Auth is a Privy access token as `Authorization: Bearer <token>`, with no cookies, sessions or CSRF surface. Browsing (catalog, listings, reviews, studio pages) never requires one.

## What's deliberately not here

No resale or secondary market, no refunds, no editing revenue splits after a game publishes, no biometric or identity verification on upload, no admin override on anything moderation touches. Each of these was cut on purpose, see [`CGS-docs/README.md`](https://github.com/cosmic-game-sanctuary/CGS-docs) for why.

## Status

Tested against Arc testnet and, from submission, running on Arc mainnet. Full history, one entry per session, is in [`CGS-docs/PROGRESS-LOG.md`](https://github.com/cosmic-game-sanctuary/CGS-docs/blob/main/PROGRESS-LOG.md).
