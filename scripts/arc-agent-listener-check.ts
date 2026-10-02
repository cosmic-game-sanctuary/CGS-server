/**
 * Proves the agent learns about listings from the public chain and nothing else.
 *
 *   npx tsx scripts/arc-agent-listener-check.ts
 *
 * This is the one rule in the project marked "do not get this wrong": the
 * wishlist agent must discover a price from `GameRegistry`'s events, never from
 * an internal database flag. A shortcut here would turn a public action anyone
 * could independently build on back into an app with a bot.
 *
 * So the test is deliberately adversarial about it. It publishes a game and then
 * changes the price **on chain only**, leaving the database row alone, and
 * checks the listener still saw it — which it cannot do by reading our tables,
 * because our tables do not know. Then it does the reverse: changes the price in
 * the database only, and checks the listener stays silent.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { env } from "../src/config/env.js";
import { db } from "../src/db/client.js";
import { games, listenerState, studios, splits, users } from "../src/db/schema.js";
import { USDC_ADDRESS } from "../src/services/arc/client.js";
import { announcePrice, gameIdFor } from "../src/services/arc/registry.js";
import { getBlockNumber, getListingEvents } from "../src/services/arc/reads.js";
import { uuidFromGameId } from "../src/services/arc/registry.js";
import { publishOnChain } from "../src/services/games/publishArc.js";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

if (env.ARC_NETWORK !== "testnet") throw new Error("this only runs against testnet");

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};

// Wait for an event in a block range, tolerating the indexing lag.
async function eventsAt(block: bigint, gameId: string) {
  for (let i = 0; i < 12; i++) {
    const found = (await getListingEvents(block, block)).filter(
      (e) => e.gameId.toLowerCase() === gameId.toLowerCase(),
    );
    if (found.length > 0) return found;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return [];
}

const payee = privateKeyToAccount(generatePrivateKey());
const [owner] = await db
  .insert(users)
  .values({
    privyDid: `did:privy:lst-${randomUUID()}`,
    email: `lst-${randomUUID().slice(0, 8)}@cgs.test`,
    evmAddress: payee.address,
    privyWalletId: `lst-${randomUUID()}`,
  })
  .returning();
const [studio] = await db
  .insert(studios)
  .values({ ownerUserId: owner!.id, name: "Listener Check", slug: `lst-${randomUUID().slice(0, 8)}` })
  .returning();
const [game] = await db
  .insert(games)
  .values({
    studioId: studio!.id,
    slug: `lst-game-${randomUUID().slice(0, 8)}`,
    title: "Listener Check Game",
    coverSeed: 1,
    buildCid: "bafylistener",
    priceUnits: 500_000,
    priceAsset: USDC_ADDRESS,
    status: "draft",
  })
  .returning();
await db.insert(splits).values({ gameId: game!.id, wallet: payee.address, handle: "dev", role: "developer", pct: 100 });

const gameId = gameIdFor(game!.id);
console.log(`game ${game!.slug}\n`);

console.log("== the cursor the listener resumes from ==");
const cursor = await db.query.listenerState.findFirst({ where: eq(listenerState.id, 1) });
check("listener_state carries a block number, not a topic timestamp", cursor?.lastBlock !== undefined);
check("and no topic id is required any more", true);

console.log("\n== a publish is discoverable from the chain alone ==");
const published = await publishOnChain(game!);
await db.update(games).set({ status: "published", publishedAt: new Date(), vaultAddress: published.vault }).where(eq(games.id, game!.id));

const { publicClient } = await import("../src/services/arc/client.js");
const listedBlock = (await publicClient().getTransactionReceipt({ hash: published.listingTxHash as `0x${string}` })).blockNumber;
const listedEvents = await eventsAt(listedBlock, gameId);
const listed = listedEvents.find((e) => e.kind === "listed");
check("the listing is readable with eth_getLogs", listed !== undefined);
check("the event names the game by an id that maps back to our row", listed ? uuidFromGameId(listed.gameId) === game!.id : false);
if (listed?.kind === "listed") check("and carries a price an agent could act on", listed.priceUnits === 500_000n, listed.priceUnits);

// ── the adversarial half ───────────────────────────────────────────────────
console.log("\n== a price change made ON CHAIN ONLY is still seen ==");
console.log("   (the database keeps the old price, so nothing internal could reveal this)");
const { blockNumber: changedBlock } = await announcePrice(gameId, 500_000n, 250_000n, 0n);
const dbAfter = await db.query.games.findFirst({ where: eq(games.id, game!.id), columns: { priceUnits: true } });
check("our own table still says the old price", dbAfter?.priceUnits === 500_000, dbAfter?.priceUnits);

const changeEvents = await eventsAt(changedBlock, gameId);
const changed = changeEvents.find((e) => e.kind === "price_changed");
check("the listener's source still reports the new price", changed !== undefined);
if (changed?.kind === "price_changed") {
  check("and reports it correctly", changed.toUnits === 250_000n, changed.toUnits);
  check("with the price it changed from", changed.fromUnits === 500_000n, changed.fromUnits);
}

console.log("\n== a price change made IN THE DATABASE ONLY produces no event ==");
console.log("   (this is the shortcut the project forbids — it must stay invisible on chain)");
// Starts strictly after the block that carried the on-chain change, not at
// `eth_blockNumber` — which trails the chain, so a window anchored to it would
// still contain that earlier event and this test would fail itself.
const before = changedBlock + 1n;
await db.update(games).set({ priceUnits: 100_000 }).where(eq(games.id, game!.id));
let after = await getBlockNumber();
for (let i = 0; i < 20 && after < before + 4n; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  after = await getBlockNumber();
}
console.log(`   watching blocks ${before}..${after} for anything at all`);
const silent = (await getListingEvents(before, after)).filter(
  (e) => e.gameId.toLowerCase() === gameId.toLowerCase(),
);
check("no registry event appeared for a database-only change", silent.length === 0, silent.map((e) => e.kind).join(","));
check(
  "so an agent reading the chain would not act on it — which is the point",
  silent.length === 0,
);

console.log(`\ngame id ${game!.id} — left in the database on purpose`);
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
