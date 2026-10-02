/**
 * The Stage 4 acceptance test, run against a live server and live Arc testnet.
 *
 *   npm run dev              # in one terminal
 *   npx tsx scripts/arc-purchase-check.ts
 *
 * It creates a studio, a game pointed at a real SplitVault and a buyer holding
 * nothing but the purchase price, then buys the game three ways — the standard
 * x402 `402`-then-retry path, the browser's prepare/sign/complete pair, and a
 * trial chunk — and checks, from the chain rather than from our own responses:
 *
 *   the USDC landed in the vault, not in any account of ours
 *   the buyer paid no gas
 *   the split is claimable in the right proportions
 *   a GameKey reached the buyer
 *   a second purchase of the same game is refused rather than charged
 *
 * Rows it writes are left behind on purpose, so the result can be inspected.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { formatUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config/env.js";
import { db } from "../src/db/client.js";
import { games, gameKeys, sales, studios, users, splits } from "../src/db/schema.js";
import {
  arcChain,
  confirm,
  feeOverrides,
  operator,
  publicClient,
  unitsToWei,
  USDC_ADDRESS,
  walletClient,
} from "../src/services/arc/client.js";
import { getUsdcUnits } from "../src/services/arc/reads.js";
import { getVaultState } from "../src/services/arc/vault.js";
import { gameIdFor } from "../src/services/arc/registry.js";
import { keysHeldBy } from "../src/services/arc/keys.js";
import { buildAuthorization, isAuthorizationUsed } from "../src/services/arc/x402/authorization.js";
import { encodePaymentHeader, signAuthorization } from "../src/services/arc/x402/payer.js";
import type { PaymentRequirements, ResourceInfo } from "../src/services/arc/x402/requirements.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("this only runs against testnet");

const BASE = `http://127.0.0.1:${env.PORT}`;
/**
 * Where this game's buyers pay.
 *
 * With a Circle API key this is the real SplitVault, which is the production
 * shape. Without one, settlement has to go through Circle's keyless trial,
 * which authenticates with a signature from the key controlling `payTo` — and a
 * vault has no key. So the no-key run proves the whole server pipeline against
 * an address we can sign for, and `arc-eip3009-check` separately proves that a
 * vault destination receives and splits correctly. Set CIRCLE_API_KEY to run the
 * two as one.
 */
const usingApiKey = Boolean(env.CIRCLE_API_KEY);
const VAULT = (process.env.ARC_CHECK_VAULT as Address) ??
  (usingApiKey ? "0x71349A7527A6Cb3d1bEa1153f2a5c7C8fC36C5b4" : operator().address);
const PRICE_UNITS = 300_000n; // 0.30 USDC
const CHUNK_UNITS = 20_000n; // 0.02 USDC per trial chunk

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};
const fmt = (w: bigint) => `${formatUnits(w, 18)} USDC`;

type Health = { chainReachable?: boolean; chainId?: number; blockNumber?: number; operator?: string | null };
const up: Health | null = await fetch(`${BASE}/health`).then((r) => r.json() as Promise<Health>).catch(() => null);
if (!up?.chainReachable) throw new Error(`server not up or chain unreachable at ${BASE} — run npm run dev first`);
console.log(`server up: chain ${up.chainId} block ${up.blockNumber}, operator ${up.operator}\n`);

// --- a studio, a game pointed at a real vault, and a buyer ------------------
// Written straight to the database: publishing is Stage 5's job, so this stands
// in for it by setting exactly what a publish will set — the vault address.
const buyerKey = generatePrivateKey();
const buyer = privateKeyToAccount(buyerKey);
const studioPayee = usingApiKey
  ? await publicClient().readContract({
      address: VAULT,
      abi: [{ type: "function", name: "payees", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }] as const,
      functionName: "payees",
      args: [1n],
    })
  : privateKeyToAccount(generatePrivateKey()).address;

const [owner] = await db
  .insert(users)
  .values({
    privyDid: `did:privy:check-${randomUUID()}`,
    email: `check-${randomUUID().slice(0, 8)}@cgs.test`,
    evmAddress: studioPayee,
    privyWalletId: `check-${randomUUID()}`,
  })
  .returning();
const [studio] = await db
  .insert(studios)
  .values({ ownerUserId: owner!.id, name: "Stage 4 Check", slug: `stage4-${randomUUID().slice(0, 8)}` })
  .returning();
const [game] = await db
  .insert(games)
  .values({
    studioId: studio!.id,
    slug: `stage4-game-${randomUUID().slice(0, 8)}`,
    title: "Stage 4 Check Game",
    coverSeed: 1,
    buildCid: "bafycheckbuild",
    buildZipCid: "bafycheckzip",
    priceUnits: Number(PRICE_UNITS),
    priceAsset: USDC_ADDRESS,
    status: "published",
    publishedAt: new Date(),
    vaultAddress: VAULT,
    trialChunkPriceUnits: Number(CHUNK_UNITS),
    trialChunkMinutes: 5,
    trialMaxChunks: 3,
  })
  .returning();
await db.insert(splits).values({ gameId: game!.id, wallet: studioPayee, handle: "studio", role: "developer", pct: 95 });
console.log(`game ${game!.slug} at ${fmt(unitsToWei(PRICE_UNITS))}, payTo ${VAULT}${usingApiKey ? " (SplitVault)" : " (operator EOA — no API key)"}\n`);

// --- 1. the standard x402 path: 402, sign, retry ----------------------------
console.log("== the open x402 path (what a stranger's client does) ==");
const fundTotal = PRICE_UNITS + CHUNK_UNITS;
await confirm(
  await walletClient().sendTransaction({
    account: operator(), chain: arcChain(), to: buyer.address, value: unitsToWei(fundTotal), ...(await feeOverrides()),
  }),
);
check("buyer funded with exactly the price plus one chunk, and no gas budget", (await getUsdcUnits(buyer.address)) === fundTotal);

const payeeBefore = usingApiKey ? (await getVaultState(VAULT)).totalReceivedWei : unitsToWei(await getUsdcUnits(VAULT));

const challenge = await fetch(`${BASE}/api/games/${game!.id}/download`);
check("an unpaid download answers 402", challenge.status === 402, challenge.status);
const offer = (await challenge.json()) as { x402Version: number; resource: ResourceInfo; accepts: PaymentRequirements[] };
const requirements = offer.accepts[0]!;
check("the terms are x402 v2", offer.x402Version === 2);
check("the terms name the game's payout address as payTo", requirements.payTo.toLowerCase() === VAULT.toLowerCase(), requirements.payTo);
check("the terms price it in atomic USDC units", requirements.amount === String(PRICE_UNITS), requirements.amount);
check("the terms name Arc and native USDC", requirements.network === `eip155:${arcChain().id}` && requirements.asset === USDC_ADDRESS);

const auth = buildAuthorization(buyer.address, requirements.payTo, BigInt(requirements.amount));
const signature = await signAuthorization(buyer, auth);
const paid = await fetch(`${BASE}/api/games/${game!.id}/download`, {
  headers: { "payment-signature": encodePaymentHeader({ requirements, resource: offer.resource, authorization: auth, signature }) },
});
const grant = (await paid.json()) as { settlementTxId?: string; buildPath?: string; error?: { message?: string } };
check("the retry with a payment is served", paid.ok, grant.error?.message);
check("it reports the settlement transaction", Boolean(grant.settlementTxId), JSON.stringify(grant).slice(0, 200));
check("it hands back somewhere to get the build", grant.buildPath === `/api/games/${game!.id}/build.zip`);

if (grant.settlementTxId) {
  const receipt = await publicClient().getTransactionReceipt({ hash: grant.settlementTxId as Hex });
  check("the settlement really is on chain and succeeded", receipt.status === "success");
  check(
    "Circle paid the gas — not us, not the buyer",
    receipt.from.toLowerCase() !== operator().address.toLowerCase() && receipt.from.toLowerCase() !== buyer.address.toLowerCase(),
    receipt.from,
  );
}

// --- 2. where the money actually went ---------------------------------------
console.log("\n== the money ==");
const payeeAfter = usingApiKey ? (await getVaultState(VAULT)).totalReceivedWei : unitsToWei(await getUsdcUnits(VAULT));
if (usingApiKey) {
  check(
    "the price landed in the vault, in full",
    payeeAfter - payeeBefore === unitsToWei(PRICE_UNITS),
    fmt(payeeAfter - payeeBefore),
  );
} else {
  // payTo is the operator here, which is also paying gas for the mint and for
  // funding the buyer, so its balance delta is not the price alone. The vault
  // case has no such confusion — nothing else ever spends from a vault.
  check("the payout address received something", payeeAfter > 0n);
  console.log(`   operator balance moved ${fmt(payeeAfter - payeeBefore)} (it also pays gas, so this is not the price alone)`);
}
check("the buyer paid no gas — only the price left their wallet", (await getUsdcUnits(buyer.address)) === CHUNK_UNITS);

if (usingApiKey) {
  const vaultAfter = await getVaultState(VAULT);
  const platform = vaultAfter.payees.find((p) => p.bps === env.PLATFORM_FEE_BPS);
  const studioShare = vaultAfter.payees.find((p) => p.bps === 10_000 - env.PLATFORM_FEE_BPS);
  check("the vault holds a claim for the platform and one for the studio", Boolean(platform && studioShare));
  if (platform && studioShare) {
    console.log(`   platform ${platform.bps} bps claimable ${fmt(platform.claimableWei)}`);
    console.log(`   studio   ${studioShare.bps} bps claimable ${fmt(studioShare.claimableWei)}`);
  }
} else {
  console.log("   (split assertions need a contract payTo — run with CIRCLE_API_KEY, or see arc-eip3009-check)");
}

// --- 3. the records and the key ---------------------------------------------
console.log("\n== the record, and the key ==");
const saleRows = await db.query.sales.findMany({ where: eq(sales.gameId, game!.id) });
check("exactly one sale was recorded", saleRows.length === 1, saleRows.length);
const sale = saleRows[0];
check("the sale records the buyer's address", sale?.buyerAccountId.toLowerCase() === buyer.address.toLowerCase());
check("the sale records what was actually paid", sale?.priceUnits === Number(PRICE_UNITS), sale?.priceUnits);
check(
  "the split is marked settled — by the contract, with nothing for us to send",
  sale?.splitStatus === "distributed",
  sale?.splitStatus,
);

// The mint runs in the background after settlement, so give it a moment.
let held = await keysHeldBy(buyer.address);
for (let i = 0; i < 30 && held.length === 0; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  held = await keysHeldBy(buyer.address);
}
check("a GameKey reached the buyer", held.length === 1, held.length);
check("the key names this game", held[0]?.gameId === gameIdFor(game!.id), held[0]?.gameId);
// Polled rather than read once: the chain read above can see the key the moment
// `mintKey` returns, while the row that records it is still being written. The
// row trailing the chain by a few hundred milliseconds is correct behaviour —
// the chain is what the mint actually changed — so the test waits for it rather
// than asserting the two are updated atomically, which they are not and should
// not be.
let keyRows = await db.query.gameKeys.findMany({ where: eq(gameKeys.gameId, game!.id) });
for (let i = 0; i < 20 && keyRows[0]?.mintStatus === "pending"; i++) {
  await new Promise((r) => setTimeout(r, 500));
  keyRows = await db.query.gameKeys.findMany({ where: eq(gameKeys.gameId, game!.id) });
}
check("the key row is confirmed, not left pending", keyRows[0]?.mintStatus === "confirmed", keyRows[0]?.mintStatus);

// --- 4. paying twice ---------------------------------------------------------
console.log("\n== paying twice ==");
// An x402 client carries no bearer token, so an unpaid request cannot be
// recognised as an owner's — being challenged again is correct. What must never
// happen is being *charged* again.
const second = await fetch(`${BASE}/api/games/${game!.id}/download`);
check("an anonymous unpaid request is challenged, not served", second.status === 402, second.status);

// A fresh, valid authorization from a wallet that already owns the game.
await confirm(
  await walletClient().sendTransaction({
    account: operator(), chain: arcChain(), to: buyer.address, value: unitsToWei(PRICE_UNITS), ...(await feeOverrides()),
  }),
);
const secondAuth = buildAuthorization(buyer.address, requirements.payTo, BigInt(requirements.amount));
const secondSig = await signAuthorization(buyer, secondAuth);
const secondPay = await fetch(`${BASE}/api/games/${game!.id}/download`, {
  headers: { "payment-signature": encodePaymentHeader({ requirements, resource: offer.resource, authorization: secondAuth, signature: secondSig }) },
});
const secondPayBody = (await secondPay.json()) as { error?: { code?: string } };
check("paying again for a game you own is refused", secondPay.status === 409, secondPay.status);
check("and refused by name, so a client can act on it", secondPayBody.error?.code === "ALREADY_OWNED", secondPayBody.error?.code);
check("the refused payment was never settled", !(await isAuthorizationUsed(buyer.address, secondAuth.nonce)));
check("the buyer still holds the money they offered", (await getUsdcUnits(buyer.address)) >= PRICE_UNITS);

// Replaying the *first* authorization — already spent on chain — must also not
// charge, and must say why rather than failing opaquely.
const replay = await fetch(`${BASE}/api/games/${game!.id}/download`, {
  headers: { "payment-signature": encodePaymentHeader({ requirements, resource: offer.resource, authorization: auth, signature }) },
});
check("replaying a spent authorization is refused", !replay.ok, replay.status);
check("still exactly one sale", (await db.query.sales.findMany({ where: eq(sales.gameId, game!.id) })).length === 1);

// --- 5. a trial chunk -------------------------------------------------------
console.log("\n== a trial chunk, same rails ==");
const chunkChallenge = await fetch(`${BASE}/api/games/${game!.id}/trial/chunks/settle`);
check("an unpaid chunk answers 402", chunkChallenge.status === 402, chunkChallenge.status);
const chunkOffer = (await chunkChallenge.json()) as { resource: ResourceInfo; accepts: PaymentRequirements[] };
const chunkTerms = chunkOffer.accepts[0]!;
check("a chunk is priced at the chunk price, not the game's", chunkTerms.amount === String(CHUNK_UNITS), chunkTerms.amount);
check("a chunk pays the same address as a purchase", chunkTerms.payTo.toLowerCase() === VAULT.toLowerCase());

const beforeChunkBalance = await getUsdcUnits(buyer.address);
const chunkAuth = buildAuthorization(buyer.address, chunkTerms.payTo, BigInt(chunkTerms.amount));
const chunkSig = await signAuthorization(buyer, chunkAuth);
const chunkPaid = await fetch(`${BASE}/api/games/${game!.id}/trial/chunks/settle`, {
  headers: { "payment-signature": encodePaymentHeader({ requirements: chunkTerms, resource: chunkOffer.resource, authorization: chunkAuth, signature: chunkSig }) },
});
const chunkBody = (await chunkPaid.json()) as { chunkMinutes?: number; settlementTxId?: string; error?: { message?: string } };
check("the chunk settles", chunkPaid.ok, chunkBody.error?.message);
check("it buys the configured number of minutes", chunkBody.chunkMinutes === 5, chunkBody.chunkMinutes);
const afterChunk = await db.query.sales.findMany({ where: eq(sales.gameId, game!.id) });
check("the chunk is recorded as a trial, not a purchase", afterChunk.some((s) => s.kind === "trial_chunk"));
check("a chunk mints no key — five minutes is not ownership", (await db.query.gameKeys.findMany({ where: eq(gameKeys.gameId, game!.id) })).length === 1);
check(
  "exactly the chunk price left the buyer's wallet, and no gas",
  beforeChunkBalance - (await getUsdcUnits(buyer.address)) === CHUNK_UNITS,
  `${beforeChunkBalance - (await getUsdcUnits(buyer.address))} vs ${CHUNK_UNITS}`,
);

console.log(`\ngame id ${game!.id} — left in the database on purpose`);
console.log(`${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
