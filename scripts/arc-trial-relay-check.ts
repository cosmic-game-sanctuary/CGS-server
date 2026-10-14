/**
 * Trial revenue reaches the game's vault, proven on the real chain and the real
 * Circle Gateway. This is the check that was missing: `arc:check:gateway`
 * asserted "the vault received the chunk price" only if a batch completed
 * within 20 seconds, which never happened, so it silently never ran, and trial
 * money was stuck inside Gateway where no payee could claim it.
 *
 *   npx tsx scripts/arc-trial-relay-check.ts      # needs the dev DB, not the server
 *
 * A batch takes a few minutes to over a quarter of an hour to land. The script
 * waits for it, so expect it to run for as long as that takes (cap 25 minutes).
 *
 * Proves, in order:
 *   - a chunk paid to the operator settles and the earnings page shows it as
 *     money on its way, not as 0 (the "earned $0 but I did earn" report)
 *   - once Circle's batch completes the relay forwards it, with the operator's
 *     float topped up automatically if it was short
 *   - the VAULT's own balance rises by exactly the chunks, and the payee can
 *     claim it from the contract
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { formatUnits, getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config/env.js";
import { db } from "../src/db/client.js";
import { games, sales, splits, studios, users } from "../src/db/schema.js";
import { arcChain, confirm, feeOverrides, operator, publicClient, unitsToWei, USDC_ADDRESS, walletClient } from "../src/services/arc/client.js";
import { getVaultState } from "../src/services/arc/vault.js";
import { publishOnChain } from "../src/services/games/publishArc.js";
import { personalEarnings } from "../src/services/earnings/report.js";
import { buildGatewayAuthorization, gatewayAvailableUnits, gatewayRequirements, gatewayTypedDataFor, settleGatewayPayment } from "../src/services/arc/x402/gateway.js";
import { relayTrialRevenue } from "../src/services/arc/x402/trialRelay.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("this only runs against testnet");

const CHUNK = 10_000n; // $0.01 each
const CHUNKS = 3;
const TOTAL = CHUNK * BigInt(CHUNKS);

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};
const fmt = (u: bigint) => `${formatUnits(u, 6)} USDC`;

// ── a developer with a real vault, and a game ───────────────────────────────
const devKey = generatePrivateKey();
const devAddr = privateKeyToAccount(devKey).address;
const [dev] = await db
  .insert(users)
  .values({ privyDid: `did:privy:relaydev-${randomUUID()}`, email: `relaydev-${randomUUID().slice(0, 8)}@cgs.test`, evmAddress: devAddr, privyWalletId: `relaydev-${randomUUID()}` })
  .returning();
const [studio] = await db.insert(studios).values({ ownerUserId: dev!.id, name: "Relay Check", slug: `relay-${randomUUID().slice(0, 8)}` }).returning();
const [draft] = await db
  .insert(games)
  .values({ studioId: studio!.id, slug: `relay-game-${randomUUID().slice(0, 8)}`, title: "Relay Check Game", coverSeed: 1, buildCid: "bafyrelay", buildZipCid: "bafyrelayzip", priceUnits: 300_000, priceAsset: USDC_ADDRESS, status: "draft" })
  .returning();
const [split] = await db.insert(splits).values({ gameId: draft!.id, userId: dev!.id, wallet: devAddr, handle: "dev", role: "developer", pct: 100 }).returning();
const res = await publishOnChain(draft!);
const [game] = await db.update(games).set({ status: "published", publishedAt: new Date(), vaultAddress: res.vault }).where(eq(games.id, draft!.id)).returning();
const vault = getAddress(game!.vaultAddress!);
console.log(`game ${game!.slug}, vault ${vault}, developer ${devAddr}\n`);

// ── a buyer who deposits into Gateway and buys chunks, paid to the operator ──
const buyerKey = generatePrivateKey();
const buyer = privateKeyToAccount(buyerKey);
await confirm(
  await walletClient().sendTransaction({ account: operator(), chain: arcChain(), to: buyer.address, value: unitsToWei(100_000n), ...(await feeOverrides()) }),
);
const { GatewayClient } = await import("@circle-fin/x402-batching/client");
await new GatewayClient({ chain: "arcTestnet", privateKey: buyerKey }).deposit("0.05");
// Mined is not credited: Gateway's own balance trails the chain by a few seconds.
for (let i = 0; i < 30 && (await gatewayAvailableUnits(buyer.address)) < 50_000n; i++) await new Promise((r) => setTimeout(r, 2000));

console.log("== three trial chunks, paid to the operator the way the route now builds them ==");
const resource = { url: "https://cgs.local/relay-check", description: "relay check chunk", mimeType: "application/json" };
const requirements = await gatewayRequirements(operator().address, CHUNK);
check("a chunk's payee is the operator, not the vault", requirements.payTo.toLowerCase() === operator().address.toLowerCase());
const transferIds: string[] = [];
for (let i = 0; i < CHUNKS; i++) {
  const auth = buildGatewayAuthorization(buyer.address, operator().address, CHUNK);
  const sig = await buyer.signTypedData(gatewayTypedDataFor(auth, requirements.extra.verifyingContract));
  const settled = await settleGatewayPayment(requirements, auth, sig, resource);
  if (settled.status !== "settled") throw new Error(`chunk ${i} did not settle: ${JSON.stringify(settled)}`);
  transferIds.push(settled.transferId);
  await db.insert(sales).values({
    gameId: game!.id, buyerAccountId: buyer.address, priceUnits: Number(CHUNK), priceAsset: USDC_ADDRESS,
    settlementTxId: settled.transferId, gatewayTransferId: settled.transferId, kind: "trial_chunk", splitStatus: "pending",
  });
}
check("three chunks settled", transferIds.length === CHUNKS);

console.log("\n== earnings, before the money has reached the vault ==");
const before = await personalEarnings(dev!.id, devAddr);
const row = before.games.find((g) => g.gameId === game!.id);
// What the vault will actually pay this person, not their percentage of the
// sale: the platform takes its cut inside the vault. Read from the contract.
const bps = before.claims[0]?.bps ?? 0;
const expected = CHUNKS * Math.floor((Number(CHUNK) * bps) / 10_000);
check("the vault's split for the developer is the 95% a publish sets up", bps === 9500, bps);
check("the game's earned figure is not 0 while trial money is on its way", (row?.yours?.earned.units ?? 0) === expected && expected > 0, row?.yours?.earned.units);
check("and it is shown as pending, at the vault's own split", (row?.yours as { pending?: { units: number } } | undefined)?.pending?.units === expected, JSON.stringify(row?.yours));
check("the headline total agrees with the rows", before.totals.earned.units === expected, before.totals.earned.units);
check("nothing is claimable yet, since nothing is in the vault", (before.claims[0]?.claimable.units ?? 0) === 0);

console.log("\n== waiting for Circle's batch, then relaying (a few minutes to ~15) ==");
const vaultBefore = (await getVaultState(vault)).totalReceivedWei;
const deadline = Date.now() + 25 * 60_000;
let relayed = false;
const mine = async () =>
  (await db.select().from(sales).where(eq(sales.gameId, game!.id))).every((s) => s.splitStatus === "distributed");
// Until *this* game's chunks are forwarded. Other games' pending chunks in the
// same database (earlier runs) are relayed too and must not end the wait.
while (Date.now() < deadline && !relayed) {
  const r = await relayTrialRevenue({ minUnits: 0n, maxAgeMs: 0 });
  for (const x of r.relayed) console.log(`   relayed ${x.units} units for game ${x.gameId} in ${x.txHash}`);
  relayed = await mine();
  if (!relayed) {
    process.stdout.write(`   waiting on ${r.waiting} chunk(s)...\r`);
    await new Promise((res2) => setTimeout(res2, 20_000));
  }
}
check("the relay ran once the batch completed", relayed);

const after = (await getVaultState(vault)).totalReceivedWei;
check("the VAULT's own balance rose by exactly the chunks", after - vaultBefore === unitsToWei(TOTAL), `${after - vaultBefore} vs ${unitsToWei(TOTAL)}`);
const native = await publicClient().getBalance({ address: vault });
check("and the vault really holds the USDC", native >= unitsToWei(TOTAL), native);
const remaining = await db.select().from(sales).where(eq(sales.gameId, game!.id));
check("the sale rows are marked distributed", remaining.every((s) => s.splitStatus === "distributed"));

console.log("\n== earnings, after ==");
const post = await personalEarnings(dev!.id, devAddr);
const postRow = post.games.find((g) => g.gameId === game!.id);
check("earned is unchanged and now nothing is pending", (postRow?.yours?.earned.units ?? 0) === expected && (postRow?.yours as { pending?: { units: number } } | undefined)?.pending?.units === 0, JSON.stringify(postRow?.yours));
check("the developer can now claim exactly the amount the page promised", post.claims[0]?.claimable.units === expected, post.claims[0]?.claimable.units);
void split;

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
