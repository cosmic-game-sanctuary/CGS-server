/**
 * The ETHOnline scenario, proven against Arc: two games the buyer wants go on
 * sale, the budget covers one, and the agent must decide which — not buy
 * whichever happened to drop first.
 *
 *   npm run dev              # in one terminal, AGENT_PURCHASE_BUFFER_MS short
 *   npx tsx scripts/arc-agent-contested-check.ts
 *
 * This is the thing `arc:check:agent` does not cover: that script wants one
 * cheap game and one too-expensive one, which `planPurchases` resolves on its
 * own with no judgement involved. Here both games are individually affordable
 * and only one is affordable *together* — the actual contested case
 * `needsJudgement` exists for, and the only shape that makes a real model call
 * happen rather than the deterministic fallback.
 *
 * What this proves, from outside the process, never by calling the sweep:
 *
 *   the agent does NOT buy the instant it can afford something — it defers
 *   a `held` row appears naming both games and the real wire time
 *   at the wire, a genuine x402-metered Groq call happens (not the fallback) —
 *     checked by a non-null inferenceTxId, a real settlement, AND that the
 *     operator's balance actually grew by the inference price
 *   exactly one game is bought, the other is declined, in the same round
 *   the key lands with the buyer, the vault received exactly the sale price
 *   the losing game was not bought by anyone
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { formatUnits, getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config/env.js";
import { db } from "../src/db/client.js";
import {
  agentDecisions,
  gameKeys,
  games,
  sales,
  splits,
  studios,
  users,
  wishlistAgents,
  wishlistItems,
} from "../src/db/schema.js";
import { operator, publicClient, unitsToWei, USDC_ADDRESS } from "../src/services/arc/client.js";
import { getVaultState } from "../src/services/arc/vault.js";
import { publishOnChain } from "../src/services/games/publishArc.js";
import { createAgent } from "../src/services/agent/wallet.js";
import { createPromotion } from "../src/services/games/promotions.js";
import { PURCHASE_BUFFER_MS } from "../src/services/agent/timing.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("this only runs against testnet");
if (PURCHASE_BUFFER_MS > 5 * 60_000) {
  throw new Error(
    `AGENT_PURCHASE_BUFFER_MS is ${PURCHASE_BUFFER_MS}ms — this test needs it short (e.g. 120000) ` +
      `so the wire arrives in minutes, not the production default of an hour. Set it in .env and restart the server.`,
  );
}

const SALE_PRICE_UNITS = 150_000n; // 0.15 USDC each — the ceiling
const BASE_PRICE_UNITS = 300_000n;
// On top of one game's price: the agent pays its own gas for registering on
// ERC-8004 (two transactions) and publishing its ceiling (one more), measured
// at ~0.024 USDC in arc:check:identity, plus the inference fee for the verdict
// call (AGENT_INFERENCE_PRICE_UNITS, 500 units). Funding with exactly the
// price and nothing else — the first version of this test did that — left the
// agent unable to afford the one game it could afford, because its own
// operating costs ate into the balance before the decision ever ran. This
// margin is well under a second game's price, so it still cannot afford both.
const OPERATING_MARGIN_UNITS = 50_000n; // 0.05 USDC
// Long enough for registration (two txs) plus a ceiling publish (one more) to
// land with real margin before the wire — measured at a few seconds each, this
// leaves well over a minute.
const SALE_LENGTH_MS = 5 * 60_000;

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};
const client = publicClient();
const fmt = (w: bigint) => `${formatUnits(w, 18)} USDC`;

const up = await fetch(`http://127.0.0.1:${env.PORT}/health`)
  .then((r) => r.json() as Promise<{ chainReachable?: boolean }>)
  .catch(() => null);
if (!up?.chainReachable) throw new Error("server not up — run npm run dev first");

console.log(`purchase buffer ${PURCHASE_BUFFER_MS}ms, sale length ${SALE_LENGTH_MS}ms -> wire in ${(SALE_LENGTH_MS - PURCHASE_BUFFER_MS) / 1000}s\n`);

// ── a buyer, a studio, two games ────────────────────────────────────────────
const buyerAddr = privateKeyToAccount(generatePrivateKey()).address;
const [buyer] = await db
  .insert(users)
  .values({
    privyDid: `did:privy:contest-${randomUUID()}`,
    email: `contest-${randomUUID().slice(0, 8)}@cgs.test`,
    evmAddress: buyerAddr,
    privyWalletId: `contest-${randomUUID()}`,
  })
  .returning();

const devAddr = privateKeyToAccount(generatePrivateKey()).address;
const [dev] = await db
  .insert(users)
  .values({
    privyDid: `did:privy:contestdev-${randomUUID()}`,
    email: `contestdev-${randomUUID().slice(0, 8)}@cgs.test`,
    evmAddress: devAddr,
    privyWalletId: `contestdev-${randomUUID()}`,
  })
  .returning();
const [studio] = await db
  .insert(studios)
  .values({ ownerUserId: dev!.id, name: "Contested Round Check", slug: `contest-${randomUUID().slice(0, 8)}` })
  .returning();

async function publishGame(label: string) {
  const [game] = await db
    .insert(games)
    .values({
      studioId: studio!.id,
      slug: `contest-${label}-${randomUUID().slice(0, 8)}`,
      title: `Contested ${label}`,
      coverSeed: 1,
      buildCid: "bafycontestbuild",
      buildZipCid: "bafycontestzip",
      priceUnits: Number(BASE_PRICE_UNITS),
      priceAsset: USDC_ADDRESS,
      status: "draft",
    })
    .returning();
  await db.insert(splits).values({ gameId: game!.id, wallet: devAddr, handle: "dev", role: "developer", pct: 100 });
  const res = await publishOnChain(game!);
  const [published] = await db
    .update(games)
    .set({ status: "published", publishedAt: new Date(), vaultAddress: res.vault })
    .where(eq(games.id, game!.id))
    .returning();
  return published!;
}

console.log("== two games the buyer wants, both published ==");
const gameA = await publishGame("alpha");
const gameB = await publishGame("beta");
console.log(`   ${gameA.slug}  (alpha)`);
console.log(`   ${gameB.slug}  (beta)`);

// Both on sale at the same price, for the same length, started together — the
// real-world case the deterministic planner cannot resolve on its own. Any
// consistent tie-break would quietly always pick the same one; what matters is
// that a genuine model call decides, not which game wins.
console.log("\n== both on sale, same price, same deadline ==");
const now = new Date();
const endsAt = new Date(now.getTime() + SALE_LENGTH_MS);
await createPromotion(gameA, { salePriceUnits: Number(SALE_PRICE_UNITS), endsAt }, dev!.id);
await createPromotion(gameB, { salePriceUnits: Number(SALE_PRICE_UNITS), endsAt }, dev!.id);
console.log(`   both at ${formatUnits(SALE_PRICE_UNITS * 10n ** 12n, 18)} USDC, ending ${endsAt.toISOString()}`);

// ── the wishlist: wants both, can afford only one ───────────────────────────
await db.insert(wishlistItems).values([
  { userId: buyer!.id, gameId: gameA.id, agentMaxUnits: Number(SALE_PRICE_UNITS) },
  { userId: buyer!.id, gameId: gameB.id, agentMaxUnits: Number(SALE_PRICE_UNITS) },
]);

const reload = async () => db.query.wishlistAgents.findFirst({ where: eq(wishlistAgents.id, agent.id) });
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

console.log("\n== an agent, funded for one of them plus its own running costs ==");
const agent = await createAgent(buyer!.id, { mode: "autonomous" });
const fundingUnits = SALE_PRICE_UNITS + OPERATING_MARGIN_UNITS;
await (
  await import("../src/services/arc/client.js")
).walletClient().sendTransaction({
  account: operator(),
  chain: (await import("../src/services/arc/client.js")).arcChain(),
  to: agent.agentEvmAddress as Address,
  // One sale price plus its own gas and inference fee — not two sale prices,
  // so the deterministic planner, and a model that ignored the ceiling, can
  // still afford at most one of the two games.
  value: fundingUnits * 10n ** 12n,
  ...(await (await import("../src/services/arc/client.js")).feeOverrides()),
});
console.log(`   agent wallet ${agent.agentEvmAddress}, funded with ${fmt(fundingUnits * 10n ** 12n)}`);

const funded = await until("the agent to register itself", reload, (a) => Boolean(a?.erc8004AgentId));
check("the agent registered on ERC-8004", Boolean(funded?.erc8004AgentId));
check("and is no longer a draft", funded?.status !== "draft", funded?.status);

// ── the deferral: the heart of the whole feature ────────────────────────────
console.log("\n== it does not buy the instant it can afford one — it waits ==");
const immediateBought = await db.query.agentDecisions.findFirst({
  where: and(eq(agentDecisions.agentId, agent.id), eq(agentDecisions.kind, "bought")),
});
check(
  "nothing was bought in the first moments after funding, though it could afford one game right now",
  immediateBought === undefined,
  immediateBought && "a purchase happened immediately — the agent did not wait for the wire",
);

const held = await until(
  "a held row naming both games",
  () =>
    db.query.agentDecisions.findFirst({
      where: and(eq(agentDecisions.agentId, agent.id), eq(agentDecisions.kind, "held")),
    }),
  (row) => row !== undefined,
);
check("a held row (the alarm clock) was written", held !== undefined);
check(
  "it names both contested games",
  held !== undefined &&
    new Set(held.consideredGameIds).size === 2 &&
    held.consideredGameIds.includes(gameA.id) &&
    held.consideredGameIds.includes(gameB.id),
  held?.consideredGameIds,
);
const expectedWire = endsAt.getTime() - PURCHASE_BUFFER_MS;
check(
  "its decideBy is the real wire — the sale's end minus the purchase buffer",
  held !== undefined && Math.abs(held.decideBy!.getTime() - expectedWire) < 15_000,
  held?.decideBy,
);
console.log(`   waiting until ${held?.decideBy?.toISOString()} to decide between both games`);

// ── wait past the wire ──────────────────────────────────────────────────────
const waitMs = Math.max(0, expectedWire - Date.now()) + 20_000;
console.log(`\n== waiting ${Math.round(waitMs / 1000)}s for the wire to actually arrive ==`);
await new Promise((r) => setTimeout(r, waitMs));

console.log("\n== at the wire: a real contested decision ==");
const bought = await until(
  "a bought decision",
  () =>
    db.query.agentDecisions.findFirst({
      where: and(eq(agentDecisions.agentId, agent.id), eq(agentDecisions.kind, "bought")),
    }),
  (row) => row !== undefined,
  60,
);
check("exactly one purchase decision was made", bought !== undefined);
check("it bought exactly one of the two games", bought?.chosenGameIds.length === 1, bought?.chosenGameIds);

// Polled, not a one-shot read: `recordDeclines` is a second INSERT, written
// after `executeBuys` returns inside the same `actOnVerdict` call — so the
// instant the "bought" row is visible is not guaranteed to be the instant the
// "declined" row is too. A one-shot read here raced that gap and failed
// intermittently; same lesson as every other "read right after a write" case
// in this codebase.
const declined = await until(
  "a declined decision for the same round",
  () =>
    db.query.agentDecisions.findFirst({
      where: and(eq(agentDecisions.agentId, agent.id), eq(agentDecisions.kind, "declined")),
    }),
  (row) => row !== undefined,
  20,
);
check("the other game was declined in the same round", declined !== undefined);
check(
  "both decisions came from the same round — they considered the same two games",
  JSON.stringify([...(bought?.consideredGameIds ?? [])].sort()) === JSON.stringify([...(declined?.consideredGameIds ?? [])].sort()),
);
check(
  "the bought and declined games are not the same game",
  bought?.chosenGameIds[0] !== declined?.chosenGameIds[0],
);

// ── proof it was a real model call, not the deterministic fallback ─────────
console.log("\n== proof this was a genuine Groq judgement, not the free fallback ==");
check("the bought row carries a non-empty explanation", Boolean(bought?.reasoning && bought.reasoning.length > 5), bought?.reasoning);
check("the bought row carries the inference cost", bought?.inferenceCostUnits === env.AGENT_INFERENCE_PRICE_UNITS, bought?.inferenceCostUnits);
check("the bought row carries a real settlement transaction", Boolean(bought?.inferenceTxId), bought?.inferenceTxId);
check("the declined row shares the same reasoning (one round, one charge)", declined?.reasoning === bought?.reasoning);
check(
  "the declined row carries no charge of its own — the round was billed once",
  declined?.inferenceCostUnits === null && declined?.inferenceTxId === null,
);

if (bought?.inferenceTxId) {
  const receipt = await client.getTransactionReceipt({ hash: bought.inferenceTxId as `0x${string}` });
  check("the inference settlement transaction actually succeeded on chain", receipt.status === "success");

  // Balance at the block right before this specific transaction vs. right
  // after it — not a broad before/after spanning the whole test. This is a
  // long-lived shared server with other agents left over from earlier runs
  // still ticking on their own schedules, each paying their own gas from
  // *their* wallets but the operator does other operator-signed work too
  // (publishing games, moving prices); a wide window can pick up unrelated
  // debits that have nothing to do with this settlement. Pinning to the one
  // transaction's own block removes that noise entirely.
  const atBlock = await client.getBalance({ address: operator().address, blockNumber: receipt.blockNumber - 1n });
  const afterBlock = await client.getBalance({ address: operator().address, blockNumber: receipt.blockNumber });
  check(
    "the operator's balance grew by exactly the inference price, at the settlement's own block",
    afterBlock - atBlock === unitsToWei(BigInt(env.AGENT_INFERENCE_PRICE_UNITS)),
    `${fmt(atBlock)} -> ${fmt(afterBlock)} (delta ${fmt(afterBlock - atBlock)})`,
  );
}

// ── the winning game really sold, the losing one really didn't ─────────────
console.log("\n== the purchase itself, checked on chain ==");
const wonId = bought?.chosenGameIds[0];
const wonGame = wonId === gameA.id ? gameA : gameB;
const lostGame = wonId === gameA.id ? gameB : gameA;
console.log(`   bought: ${wonGame.slug}   declined: ${lostGame.slug}`);

const wonSale = await db.query.sales.findFirst({ where: eq(sales.gameId, wonGame.id) });
check("a sale was recorded for the won game", wonSale !== undefined);
check("at the sale price", wonSale?.priceUnits === Number(SALE_PRICE_UNITS), wonSale?.priceUnits);

const key = await db.query.gameKeys.findFirst({ where: eq(gameKeys.gameId, wonGame.id) });
check("a GameKey was minted for the won game", key !== undefined);
check(
  "it belongs to the buyer, never the agent",
  key?.ownerAccountId.toLowerCase() === buyerAddr.toLowerCase(),
  key?.ownerAccountId,
);

const vaultState = await getVaultState(getAddress(wonGame.vaultAddress!));
check(
  "the won game's vault received exactly the sale price",
  vaultState.totalReceivedWei === SALE_PRICE_UNITS * 10n ** 12n,
  fmt(vaultState.totalReceivedWei),
);

const lostSale = await db.query.sales.findFirst({ where: eq(sales.gameId, lostGame.id) });
check("no sale was recorded for the declined game", lostSale === undefined);
const lostKey = await db.query.gameKeys.findFirst({ where: eq(gameKeys.gameId, lostGame.id) });
check("no key was minted for the declined game", lostKey === undefined);
const lostVault = await getVaultState(getAddress(lostGame.vaultAddress!));
check("the declined game's vault received nothing", lostVault.totalReceivedWei === 0n);

console.log(`\nagent ${agent.id}, bought ${wonGame.slug}, declined ${lostGame.slug}`);
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
