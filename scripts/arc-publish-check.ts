/**
 * The Stage 5 acceptance test: publishing and claiming, against live Arc testnet.
 *
 *   npx tsx scripts/arc-publish-check.ts
 *
 * What it proves, from the chain rather than from our own responses:
 *
 *   publishing deploys the game's vault and lists it on GameRegistry
 *   the vault's split matches the splits the studio agreed, platform cut included
 *   a half-failed publish can be retried without making a second vault
 *   the split cannot be altered afterwards by anyone, us included
 *   a buyer's money lands in the vault and is divided by the contract
 *   three payees holding NO USDC each claim their exact share
 *   nothing is left stranded in the vault
 *
 * The claim half is the part that needs a live chain to mean anything: gas on Arc
 * is USDC, so a payee with an empty wallet cannot pay for their own withdrawal,
 * and `claimFor` is the only reason they can be paid at all.
 *
 * Rows it writes are left behind on purpose, so the result can be inspected.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { formatUnits, getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config/env.js";
import { db } from "../src/db/client.js";
import { games, splits, studios, users } from "../src/db/schema.js";
import {
  confirm,
  feeOverrides,
  operator,
  platformPayoutAddress,
  publicClient,
  unitsToWei,
  USDC_ADDRESS,
  walletClient,
  weiToUnits,
} from "../src/services/arc/client.js";
import { gameIdFor, getListing } from "../src/services/arc/registry.js";
import { getVaultState } from "../src/services/arc/vault.js";
import { deployVault, existingVault, toBasisPoints } from "../src/services/arc/vaultFactory.js";
import { getListingEvents } from "../src/services/arc/reads.js";
import { publishOnChain } from "../src/services/games/publishArc.js";
import { claimFromVault, claimsFor, NothingToClaim } from "../src/services/earnings/claims.js";
import { buildAuthorization } from "../src/services/arc/x402/authorization.js";
import { buildRequirements } from "../src/services/arc/x402/requirements.js";
import { signAuthorization } from "../src/services/arc/x402/payer.js";
import { awaitSettlement, settlePayment } from "../src/services/arc/x402/facilitator.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("this only runs against testnet");

const PRICE_UNITS = 400_000n; // 0.40 USDC — divides cleanly three ways after the platform cut

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};
const fmt = (w: bigint) => `${formatUnits(w, 18)} USDC`;
const client = publicClient();

// ── a studio with three people on the splits ────────────────────────────────
// Three fresh addresses, so every payee starts with nothing at all — which is
// the case that matters for claiming.
const payees = [
  { handle: "lead", role: "developer", pct: 50, account: privateKeyToAccount(generatePrivateKey()) },
  { handle: "artist", role: "artist", pct: 30, account: privateKeyToAccount(generatePrivateKey()) },
  { handle: "composer", role: "audio", pct: 20, account: privateKeyToAccount(generatePrivateKey()) },
];

const [owner] = await db
  .insert(users)
  .values({
    privyDid: `did:privy:s5-${randomUUID()}`,
    email: `s5-${randomUUID().slice(0, 8)}@cgs.test`,
    evmAddress: payees[0]!.account.address,
    privyWalletId: `s5-${randomUUID()}`,
  })
  .returning();
const [studio] = await db
  .insert(studios)
  .values({ ownerUserId: owner!.id, name: "Stage 5 Check", slug: `stage5-${randomUUID().slice(0, 8)}` })
  .returning();
const [game] = await db
  .insert(games)
  .values({
    studioId: studio!.id,
    slug: `stage5-game-${randomUUID().slice(0, 8)}`,
    title: "Stage 5 Check Game",
    coverSeed: 1,
    buildCid: "bafys5build",
    buildZipCid: "bafys5zip",
    priceUnits: Number(PRICE_UNITS),
    priceAsset: USDC_ADDRESS,
    status: "draft",
  })
  .returning();
await db.insert(splits).values(
  payees.map((p) => ({
    gameId: game!.id,
    wallet: p.account.address,
    handle: p.handle,
    role: p.role,
    pct: p.pct,
  })),
);

const gameId = gameIdFor(game!.id);
console.log(`game ${game!.slug} at ${formatUnits(unitsToWei(PRICE_UNITS), 18)} USDC, split 50/30/20 + 5% platform\n`);

// ── publishing ─────────────────────────────────────────────────────────────
console.log("== publishing: a vault, then a listing ==");
check("the game has no vault before publish", (await existingVault(gameId)) === null);
check("and is not listed", !(await getListing(gameId)).published);

const published = await publishOnChain(game!);
await db.update(games).set({ status: "published", publishedAt: new Date(), vaultAddress: published.vault }).where(eq(games.id, game!.id));
console.log(`   vault ${published.vault}`);
console.log(`   deploy ${published.vaultTxHash}`);
console.log(`   listing ${published.listingTxHash}`);

check("a vault was deployed", published.vault !== undefined && published.vault !== null);
check("the factory records it against this game", (await existingVault(gameId)) === published.vault);

const listing = await getListing(gameId);
check("the registry lists the game", listing.published);
check("and lists it against the vault that was just deployed", listing.vault === published.vault);
check("it is not delisted", !listing.delisted);

// ── the split the contract will actually honour ─────────────────────────────
console.log("\n== the split, as the contract holds it ==");
const state = await getVaultState(published.vault);
const platform = platformPayoutAddress();

check("the vault has four payees — three people and the platform", state.payees.length === 4, state.payees.length);
check(
  "the platform's cut is the configured fee",
  state.payees.find((p) => getAddress(p.address) === getAddress(platform))?.bps === env.PLATFORM_FEE_BPS,
);
for (const p of payees) {
  const onChain = state.payees.find((v) => getAddress(v.address) === getAddress(p.account.address));
  const expected = Math.floor(((10_000 - env.PLATFORM_FEE_BPS) * p.pct) / 100);
  console.log(`   ${p.handle.padEnd(9)} ${p.pct}% of the studio's share -> ${onChain?.bps} bps of the sale`);
  check(`${p.handle}'s share is on chain`, onChain !== undefined);
  // The largest share absorbs the rounding remainder, so it can be a hair over.
  check(
    `${p.handle}'s share is their percentage of what the studio keeps`,
    onChain!.bps === expected || (onChain!.bps > expected && p.pct === 50),
    `${onChain!.bps} vs ${expected}`,
  );
}
check(
  "every basis point is allocated, so nothing can be stranded",
  state.payees.reduce((sum, p) => sum + p.bps, 0) === 10_000,
  state.payees.reduce((sum, p) => sum + p.bps, 0),
);

// ── the listing is readable by anyone, which is the whole point ─────────────
console.log("\n== the listing is public, and readable without asking us ==");
// Anchored to the receipt's own block rather than to eth_blockNumber, which
// trails what a `latest` state read already sees — so a window ending at
// "latest" can genuinely exclude a transaction that is already confirmed. The
// retry is for the same reason on the indexing side: the log is written before
// it is queryable. Both are the lag documented in services/arc/reads.ts, and
// anything reading these events (the agent, next) has to tolerate them too.
const listedAt = (await client.getTransactionReceipt({ hash: published.listingTxHash as `0x${string}` })).blockNumber;
let mine: Awaited<ReturnType<typeof getListingEvents>> = [];
for (let attempt = 0; attempt < 10; attempt++) {
  const events = await getListingEvents(listedAt, listedAt);
  mine = events.filter((e) => e.gameId.toLowerCase() === gameId.toLowerCase());
  if (mine.length > 0) break;
  await new Promise((r) => setTimeout(r, 1500));
}
const listed = mine.find((e) => e.kind === "listed");
check(`the publish is in GameRegistry's logs (block ${listedAt})`, listed !== undefined);
if (listed?.kind === "listed") {
  check("the logged vault is this game's vault", getAddress(listed.vault) === getAddress(published.vault));
  check("the logged price is the price", listed.priceUnits === PRICE_UNITS, listed.priceUnits);
  check("the logged slug identifies the game", listed.slug === game!.slug);
}

// ── every later change to the listing also lands on chain ──────────────────
// These are what the agent reads after the first listing, and every one of them
// is now a contract call rather than a free-form topic message. Untested, they
// are the difference between a price the agent can see and one only we can.
console.log("\n== a price change, a delisting and a relisting ==");
const { changePrice } = await import("../src/services/games/listing.js");
const priced = await db.query.games.findFirst({ where: eq(games.id, game!.id) });
const changed = await changePrice(priced!, 250_000, null);
check("a price change is recorded on chain", changed.announced);
check("and the row carries the transaction that recorded it", changed.change.chainTxHash !== null);

const { announce } = await import("../src/services/games/listing.js");
const delisted = await announce({ ...priced!, priceUnits: 250_000 }, "delisted");
check("a delisting is recorded on chain", delisted !== null);
check("and the registry now reports the game as delisted", (await getListing(gameId)).delisted);

const relisted = await announce({ ...priced!, priceUnits: 250_000 }, "relisted");
check("a relisting is recorded on chain", relisted !== null);
check("and the registry reports it listed again", !(await getListing(gameId)).delisted);

const demanded = await announce({ ...priced!, priceUnits: 250_000 }, "demand", {
  wishlistCount: 137,
  milestone: 100,
});
check("a demand milestone is published too", demanded !== null);

// Restore the price, so the sale below is for the amount the vault expects.
await db.update(games).set({ priceUnits: Number(PRICE_UNITS) }).where(eq(games.id, game!.id));

// ── retrying a publish ─────────────────────────────────────────────────────
console.log("\n== a publish that half-failed can be retried ==");
const retry = await publishOnChain({ ...game!, status: "published" });
check("the retry returns the same vault", retry.vault === published.vault);
check("it deployed nothing new", retry.vaultTxHash === null);
check("and re-listed nothing", retry.listingTxHash === null);

// ── the split cannot be changed ────────────────────────────────────────────
console.log("\n== the split cannot be altered by anyone, us included ==");
const greedy = toBasisPoints([{ wallet: operator().address, pct: 100 }]);
const hostile = await deployVault(gameId, greedy);
check("deploying again with a different split returns the original vault", hostile.vault === published.vault);
const after = await getVaultState(published.vault);
check(
  "and the original split is untouched",
  after.payees.every((p) => state.payees.some((o) => o.address === p.address && o.bps === p.bps)),
);
check(
  "the operator did not acquire a share",
  !after.payees.some((p) => getAddress(p.address) === getAddress(operator().address) && getAddress(operator().address) !== getAddress(platform)),
);

// ── someone buys it ────────────────────────────────────────────────────────
console.log("\n== a sale, paid straight into the vault ==");
const buyer = privateKeyToAccount(generatePrivateKey());
const priceWei = unitsToWei(PRICE_UNITS);
await confirm(
  await walletClient().sendTransaction({
    account: operator(),
    chain: (await import("../src/services/arc/client.js")).arcChain(),
    to: buyer.address,
    value: priceWei,
    ...(await feeOverrides()),
  }),
);
check("the buyer holds exactly the price and no gas", (await client.getBalance({ address: buyer.address })) === priceWei);

const beforeSale = await getVaultState(published.vault);
const auth = buildAuthorization(buyer.address, published.vault, PRICE_UNITS);
const signature = await signAuthorization(buyer, auth);
const requirements = buildRequirements(published.vault, PRICE_UNITS);
const outcome = await awaitSettlement(
  await settlePayment({
    requirements,
    resource: { url: `https://cgs.test/games/${game!.slug}`, description: game!.title, mimeType: "application/json" },
    authorization: auth,
    signature,
    paymentId: `s5-${randomUUID()}`,
  }),
  published.vault,
);
check("Circle settled the sale", outcome.status === "settled", outcome.status === "failed" ? outcome.message : outcome.status);
if (outcome.status !== "settled") {
  console.log(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log(`   ${outcome.transaction}`);

const afterSale = await getVaultState(published.vault);
check("the price arrived in the vault", afterSale.totalReceivedWei - beforeSale.totalReceivedWei === priceWei, fmt(afterSale.totalReceivedWei - beforeSale.totalReceivedWei));
check("the buyer paid the price and no gas", (await client.getBalance({ address: buyer.address })) === 0n);

// ── claiming, from wallets that cannot afford a transaction ────────────────
console.log("\n== three payees with nothing in their wallets, claiming ==");
for (const p of payees) {
  check(`${p.handle} holds no USDC at all, so they could not pay for their own claim`, (await client.getBalance({ address: p.account.address })) === 0n);
}

const reported = await claimsFor(payees[0]!.account.address, [game!.id]);
check("the dashboard reports a claim for this game", reported.length === 1);
check("and the figure comes from the vault, not from our tables", reported[0]?.claimable.units === Number(weiToUnits(afterSale.payees.find((v) => getAddress(v.address) === getAddress(payees[0]!.account.address))!.claimableWei)));

let totalPaid = 0n;
for (const p of payees) {
  const expectedWei = afterSale.payees.find((v) => getAddress(v.address) === getAddress(p.account.address))!.claimableWei;
  const result = await claimFromVault(p.account.address, game!.id);
  const balance = await client.getBalance({ address: p.account.address });
  totalPaid += balance;
  console.log(`   ${p.handle.padEnd(9)} claimed ${fmt(balance)}  ${result.txHash}`);
  check(`${p.handle} received exactly what the vault owed them`, balance === expectedWei, `${fmt(balance)} vs ${fmt(expectedWei)}`);
  check(`${p.handle} paid no gas for it`, result.to === getAddress(p.account.address));
}

console.log("\n== nothing left over, and nothing claimable twice ==");
for (const p of payees) {
  let refused = false;
  try {
    await claimFromVault(p.account.address, game!.id);
  } catch (err) {
    refused = err instanceof NothingToClaim;
  }
  check(`${p.handle} cannot claim the same share twice`, refused);
}

let strangerRefused = false;
try {
  await claimFromVault(privateKeyToAccount(generatePrivateKey()).address, game!.id);
} catch (err) {
  strangerRefused = err instanceof NothingToClaim;
}
check("someone who is not a payee cannot claim anything", strangerRefused);

const final = await getVaultState(published.vault);
const platformClaimable = final.payees.find((p) => getAddress(p.address) === getAddress(platform))!.claimableWei;
const stillOwed = final.payees.reduce((sum, p) => sum + p.claimableWei, 0n);
console.log(`   paid out to the three developers: ${fmt(totalPaid)}`);
console.log(`   still claimable (the platform's own cut): ${fmt(platformClaimable)}`);
check("the only thing left to claim is the platform's share", stillOwed === platformClaimable, fmt(stillOwed));
check(
  "every unit the vault ever received is either paid out or claimable by someone",
  final.payees.reduce((sum, p) => sum + p.claimedWei + p.claimableWei, 0n) === final.totalReceivedWei,
);
check("the vault's remaining balance is exactly what is still owed", (await client.getBalance({ address: published.vault })) === stillOwed);

console.log(`\ngame id ${game!.id} — left in the database on purpose`);
console.log(`vault ${published.vault}`);
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
