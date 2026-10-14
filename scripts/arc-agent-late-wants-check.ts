/**
 * The Render failure on 13 Oct, reproduced and fixed: an agent holding 9 USDC
 * against two live sales bought neither. Wants set *after* the agent registered
 * (the normal order for a person: create, fund, then say what you want), saved
 * a moment apart, with one maximum raised after the last on-chain publish.
 *
 *   npm run dev              # in one terminal, AGENT_PURCHASE_BUFFER_MS=120000
 *   npx tsx scripts/arc-agent-late-wants-check.ts
 *
 * Two bugs, both exercised here:
 *   1. `publishAgentMandate` dropped a call that overlapped a running one, so
 *      two quick saves left the chain on the first want's number.
 *   2. At the wire, a purchase above that stale ceiling was "republish and
 *      decide next round" — and a passed wire is never scheduled again, so the
 *      agent wrote nothing and went idle until the sale ended.
 *
 * Passes only if both games are bought at the wire, in the same round, and the
 * ceiling on the agent's ERC-8004 token ends up at the buyer's real maximum.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { formatUnits, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config/env.js";
import { db } from "../src/db/client.js";
import { agentDecisions, gameKeys, games, sales, splits, studios, users, wishlistAgents, wishlistItems } from "../src/db/schema.js";
import { arcChain, feeOverrides, operator, unitsToWei, USDC_ADDRESS, walletClient } from "../src/services/arc/client.js";
import { publishOnChain } from "../src/services/games/publishArc.js";
import { createAgent } from "../src/services/agent/wallet.js";
import { createPromotion } from "../src/services/games/promotions.js";
import { ceilingFromChain, publishAgentMandate } from "../src/services/agent/mandate.js";
import { PURCHASE_BUFFER_MS } from "../src/services/agent/timing.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("this only runs against testnet");
if (PURCHASE_BUFFER_MS > 5 * 60_000) throw new Error(`AGENT_PURCHASE_BUFFER_MS is ${PURCHASE_BUFFER_MS}; set 120000 and restart the server.`);

const PRICE_A = 120_000; // 0.12
const PRICE_B = 140_000; // 0.14
const LOW_MAX = 100_000; // below both prices: what the chain is left holding
const HIGH_A = 150_000;
const HIGH_B = 180_000; // the real maximum, the one the chain must end up with
const SALE_LENGTH_MS = 5 * 60_000;

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};
async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, seconds = 90): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  let last = await read();
  while (Date.now() < deadline && !ok(last)) {
    await new Promise((r) => setTimeout(r, 2000));
    last = await read();
  }
  if (!ok(last)) console.log(`   (gave up waiting for ${what} after ${seconds}s)`);
  return last;
}

const up = await fetch(`http://127.0.0.1:${env.PORT}/health`).then((r) => r.json() as Promise<{ chainReachable?: boolean }>).catch(() => null);
if (!up?.chainReachable) throw new Error("server not up — run npm run dev first");

const buyerAddr = privateKeyToAccount(generatePrivateKey()).address;
const devAddr = privateKeyToAccount(generatePrivateKey()).address;
const mk = async (tag: string, evmAddress: Address) =>
  (await db.insert(users).values({ privyDid: `did:privy:${tag}-${randomUUID()}`, email: `${tag}-${randomUUID().slice(0, 8)}@cgs.test`, evmAddress, privyWalletId: `${tag}-${randomUUID()}` }).returning())[0]!;
const buyer = await mk("late", buyerAddr);
const dev = await mk("latedev", devAddr);
const [studio] = await db.insert(studios).values({ ownerUserId: dev.id, name: "Late Wants Check", slug: `late-${randomUUID().slice(0, 8)}` }).returning();

async function publishGame(label: string) {
  const [game] = await db.insert(games).values({
    studioId: studio!.id, slug: `late-${label}-${randomUUID().slice(0, 8)}`, title: `Late ${label}`, coverSeed: 1,
    buildCid: "bafylatebuild", buildZipCid: "bafylatezip", priceUnits: 300_000, priceAsset: USDC_ADDRESS, status: "draft",
  }).returning();
  await db.insert(splits).values({ gameId: game!.id, wallet: devAddr, handle: "dev", role: "developer", pct: 100 });
  const res = await publishOnChain(game!);
  return (await db.update(games).set({ status: "published", publishedAt: new Date(), vaultAddress: res.vault }).where(eq(games.id, game!.id)).returning())[0]!;
}

console.log("== an agent funded for both games, with NO wants yet ==");
const agent = await createAgent(buyer.id, { mode: "autonomous" });
const fundUnits = BigInt(PRICE_A + PRICE_B) + 90_000n; // both prices plus room for its own gas
await walletClient().sendTransaction({
  account: operator(), chain: arcChain(), to: agent.agentEvmAddress as Address,
  value: unitsToWei(fundUnits), ...(await feeOverrides()),
});
const reload = () => db.query.wishlistAgents.findFirst({ where: eq(wishlistAgents.id, agent.id) });
const registered = await until("the agent to register", reload, (a) => Boolean(a?.erc8004AgentId));
check("the agent registered before any want existed", Boolean(registered?.erc8004AgentId));
const live = registered!;

const gameA = await publishGame("alpha");
const gameB = await publishGame("beta");
const setMax = (gameId: string, max: number) =>
  db.insert(wishlistItems).values({ userId: buyer.id, gameId, agentMaxUnits: max }).onConflictDoUpdate({
    target: [wishlistItems.userId, wishlistItems.gameId], set: { agentMaxUnits: max },
  });

console.log("\n== bug 1: two wants saved a moment apart, both publishes overlapping ==");
await setMax(gameA.id, LOW_MAX);
await setMax(gameB.id, HIGH_B);
// What two PATCH /wishlist requests do: each fires a publish. Before the fix
// the second was dropped and the chain kept whatever the first had read.
await Promise.all([publishAgentMandate(live), publishAgentMandate(live)]);
const afterBoth = await until("the ceiling to settle", () => ceilingFromChain(live), (c) => c === HIGH_B, 20);
check("the on-chain ceiling is the higher of the two wants, not the first one saved", afterBoth === HIGH_B, afterBoth);

console.log("\n== bug 2: a maximum raised after the last publish, so the chain is behind ==");
await setMax(gameA.id, LOW_MAX);
await setMax(gameB.id, LOW_MAX);
await publishAgentMandate(live);
const low = await until("the ceiling to drop", () => ceilingFromChain(live), (c) => c === LOW_MAX, 20);
check("the chain is holding the low ceiling", low === LOW_MAX, low);
await setMax(gameA.id, HIGH_A); // raised, deliberately NOT published
await setMax(gameB.id, HIGH_B);
check("and the chain really is behind the buyer's wants", (await ceilingFromChain(live)) === LOW_MAX);

console.log("\n== both games go on sale; the wire is a few minutes away ==");
const endsAt = new Date(Date.now() + SALE_LENGTH_MS);
await createPromotion(gameA, { salePriceUnits: PRICE_A, endsAt }, dev.id);
await createPromotion(gameB, { salePriceUnits: PRICE_B, endsAt }, dev.id);
console.log(`   wire in about ${(SALE_LENGTH_MS - PURCHASE_BUFFER_MS) / 1000}s, sale ends ${endsAt.toISOString()}`);

console.log("\n== waiting for the wire; the agent must buy both anyway ==");
const bothSold = await until(
  "both purchases",
  // Sales are recorded under the person the key goes to, not the agent that paid.
  async () => (await db.select().from(sales).where(inArray(sales.gameId, [gameA.id, gameB.id]))).length,
  (n) => n >= 2,
  SALE_LENGTH_MS / 1000 + 60,
);
check("both games were bought", bothSold >= 2, bothSold);

const keyA = await db.query.gameKeys.findFirst({ where: eq(gameKeys.gameId, gameA.id) });
const keyB = await db.query.gameKeys.findFirst({ where: eq(gameKeys.gameId, gameB.id) });
check("both keys belong to the buyer, never the agent",
  keyA?.ownerAccountId.toLowerCase() === buyerAddr.toLowerCase() && keyB?.ownerAccountId.toLowerCase() === buyerAddr.toLowerCase());
const bought = await db.query.agentDecisions.findFirst({ where: eq(agentDecisions.agentId, agent.id) });
check("a decision row was written, so the page can explain what happened", bought !== undefined);
const finalCeiling = await until("the ceiling to be republished", () => ceilingFromChain(live), (c) => c === HIGH_B, 30);
check("the ceiling on the token was brought up to the buyer's real maximum", finalCeiling === HIGH_B, finalCeiling);

console.log(`\nagent ${agent.id}; spent ${formatUnits(BigInt(PRICE_A + PRICE_B), 6)} USDC across both games`);
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
