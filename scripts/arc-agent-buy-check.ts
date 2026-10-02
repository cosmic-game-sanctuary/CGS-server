/**
 * The Stage 6 acceptance test: an agent registers itself, learns about a game
 * from the chain, and buys it within a mandate published on chain.
 *
 *   npm run dev              # in one terminal
 *   npx tsx scripts/arc-agent-buy-check.ts
 *
 * This is the test that was missing, and its absence is how the agent came to be
 * non-functional on Arc without anything failing: the listener was proven to
 * read the chain, and the agent was proven to decide, but nothing exercised the
 * step between them. **No agent could leave `draft`**, because the only code path
 * that funded one asked the Hedera mirror node whether its wallet existed.
 *
 * So this walks the whole life of an agent:
 *
 *   draft, with an empty wallet, and it stays draft
 *   funded, and the sweep registers it on ERC-8004 and publishes its ceiling
 *   a game is published and the agent learns of it from GameRegistry's logs
 *   it buys within the ceiling, and the key goes to its *buyer*, not to itself
 *   a game above the ceiling is refused, with nothing signed
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { formatUnits, getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config/env.js";
import { db } from "../src/db/client.js";
import { games, gameKeys, sales, splits, studios, users, wishlistAgents, wishlistItems } from "../src/db/schema.js";
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
import { gameIdFor } from "../src/services/arc/registry.js";
import { getVaultState } from "../src/services/arc/vault.js";
import { keysHeldBy } from "../src/services/arc/keys.js";
import { publishOnChain } from "../src/services/games/publishArc.js";
import { createAgent } from "../src/services/agent/wallet.js";
// Deliberately not importing `runAgentSweep` or `evaluateAgent`. See below.
import { ceilingFromChain } from "../src/services/agent/mandate.js";
import { readRegistration } from "../src/services/agent/identity.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("this only runs against testnet");

const CHEAP_UNITS = 120_000n; // 0.12 USDC — inside the ceiling
const DEAR_UNITS = 900_000n; // 0.90 USDC — above it
const CEILING_UNITS = 200_000n; // 0.20 USDC

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};
const client = publicClient();

const up = await fetch(`http://127.0.0.1:${env.PORT}/health`).then((r) => r.json() as Promise<{ chainReachable?: boolean }>).catch(() => null);
if (!up?.chainReachable) throw new Error("server not up — run npm run dev first");

// ── a buyer, a studio, and a game they want ────────────────────────────────
const buyerAddr = privateKeyToAccount(generatePrivateKey()).address;
const [buyer] = await db
  .insert(users)
  .values({
    privyDid: `did:privy:s6-${randomUUID()}`,
    email: `s6-${randomUUID().slice(0, 8)}@cgs.test`,
    evmAddress: buyerAddr,
    privyWalletId: `s6-${randomUUID()}`,
  })
  .returning();

const devAddr = privateKeyToAccount(generatePrivateKey()).address;
const [dev] = await db
  .insert(users)
  .values({
    privyDid: `did:privy:s6dev-${randomUUID()}`,
    email: `s6dev-${randomUUID().slice(0, 8)}@cgs.test`,
    evmAddress: devAddr,
    privyWalletId: `s6dev-${randomUUID()}`,
  })
  .returning();
const [studio] = await db
  .insert(studios)
  .values({ ownerUserId: dev!.id, name: "Stage 6 Check", slug: `stage6-${randomUUID().slice(0, 8)}` })
  .returning();

async function publishGame(priceUnits: bigint, label: string) {
  const [game] = await db
    .insert(games)
    .values({
      studioId: studio!.id,
      slug: `s6-${label}-${randomUUID().slice(0, 8)}`,
      title: `Stage 6 ${label}`,
      coverSeed: 1,
      buildCid: "bafys6build",
      buildZipCid: "bafys6zip",
      priceUnits: Number(priceUnits),
      priceAsset: USDC_ADDRESS,
      status: "draft",
    })
    .returning();
  await db.insert(splits).values({ gameId: game!.id, wallet: devAddr, handle: "dev", role: "developer", pct: 100 });
  const res = await publishOnChain(game!);
  await db
    .update(games)
    .set({ status: "published", publishedAt: new Date(), vaultAddress: res.vault })
    .where(eq(games.id, game!.id));
  return { game: game!, vault: res.vault, listingTx: res.listingTxHash };
}

// ── the agent, starting with nothing ───────────────────────────────────────
/**
 * **Nothing here drives the agent.** The running server sweeps every
 * `AGENT_SWEEP_INTERVAL_MS` and polls GameRegistry on the same clock, so this
 * script only sets the world up and then waits for the real system to act.
 *
 * Calling `runAgentSweep` or `evaluateAgent` directly is what the first version
 * did, and it raced the server's own sweep for the same conditional-UPDATE
 * claim: the agent was found mid-round in `buying`, and a check that asserted
 * `funded` failed on a system that was working correctly. This repo already had
 * that lesson written down from Stage 18 — assert the outcome, never the
 * mechanism.
 */
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

console.log("== an agent with an empty wallet stays draft ==");
const agent = await createAgent(buyer!.id, { mode: "autonomous" });
console.log(`   agent wallet ${agent.agentEvmAddress}`);
check("it starts as a draft", agent.status === "draft", agent.status);
check("its wallet holds nothing", (await client.getBalance({ address: agent.agentEvmAddress as Address })) === 0n);

// Long enough for the server to have swept several times.
await new Promise((r) => setTimeout(r, 12_000));
const stillDraft = await reload();
check("several sweeps leave an unfunded agent alone", stillDraft?.status === "draft", stillDraft?.status);
check("and it has no ERC-8004 identity yet", stillDraft?.erc8004AgentId === null);

// ── funding it ─────────────────────────────────────────────────────────────
// **The want is recorded before the wallet is funded, and the order matters.**
// The sweep publishes the agent's ceiling at the moment it registers, and the
// ceiling is the highest maximum across its buyer's wants — so an agent
// registered before any want exists publishes a zero. In the app that
// self-corrects, because the route that records a want republishes the mandate;
// this script writes the row directly and would never trigger that.
console.log("\n== a game it wants, and a ceiling to want it under ==");
const cheap = await publishGame(CHEAP_UNITS, "cheap");
await db.insert(wishlistItems).values({
  userId: buyer!.id,
  gameId: cheap.game.id,
  agentMaxUnits: Number(CEILING_UNITS),
});
console.log(`   ${cheap.game.slug} at ${CHEAP_UNITS} units, wanted up to ${CEILING_UNITS}`);

console.log("\n== funding it, which is what lets it register itself ==");
const funding = unitsToWei(500_000n); // 0.50 USDC: registration plus the cheap game
await confirm(
  await walletClient().sendTransaction({
    account: operator(),
    chain: arcChain(),
    to: agent.agentEvmAddress as Address,
    value: funding,
    ...(await feeOverrides()),
  }),
);
check("the agent wallet is funded", (await client.getBalance({ address: agent.agentEvmAddress as Address })) === funding);

// Waiting for the server's own sweep to notice the balance and register it.
const funded = await until("the agent to be registered", reload, (a) => Boolean(a?.erc8004AgentId));
check("the server's own sweep registers it once it is funded", Boolean(funded?.erc8004AgentId), funded?.status);
check(
  "and it is no longer a draft",
  funded?.status !== "draft",
  funded?.status,
);
console.log(`   ERC-8004 agent id ${funded?.erc8004AgentId}  (status ${funded?.status})`);

const file = await readRegistration(BigInt(funded!.erc8004AgentId!));
check("its registration file is readable from the chain", file !== null);
check(
  "and names its buyer as the funding principal",
  String(file?.["cgs:fundingPrincipal"]).toLowerCase() === buyerAddr.toLowerCase(),
  file?.["cgs:fundingPrincipal"],
);

const published = await ceilingFromChain(funded!);
check("its spending ceiling is published on chain", published === Number(CEILING_UNITS), published);

// ── buying, within the mandate ─────────────────────────────────────────────
console.log("\n== it buys a game it learned about from the chain ==");
const vaultBefore = await getVaultState(cheap.vault);
const agentBefore = await client.getBalance({ address: agent.agentEvmAddress as Address });

// The server buys this on its own. Several rounds will run while we wait, so
// this is also the double-purchase test: however many times it evaluates, there
// must be exactly one sale. A repeat attempt is refused with `ALREADY_OWNED`
// and logged as an error by the purchase loop, which is correct rather than a
// failure.
const sold = await until(
  "the agent to buy the game",
  () => db.query.sales.findMany({ where: eq(sales.gameId, cheap.game.id) }),
  (rows) => rows.length > 0,
);
check("exactly one sale was recorded", sold.length === 1, sold.length);
check("it is a purchase, not a trial", sold[0]?.kind === "purchase");
check("and it paid the game's price", sold[0]?.priceUnits === Number(CHEAP_UNITS), sold[0]?.priceUnits);

// Measured against the vault's total rather than a delta from `vaultBefore`,
// since the sweep's purchase may have landed before that snapshot was taken.
const vaultAfter = await getVaultState(cheap.vault);
check(
  "the money went to the game's vault",
  vaultAfter.totalReceivedWei >= unitsToWei(CHEAP_UNITS),
  formatUnits(vaultAfter.totalReceivedWei, 18),
);
check(
  "the vault received the price exactly once",
  vaultAfter.totalReceivedWei === unitsToWei(CHEAP_UNITS),
  formatUnits(vaultAfter.totalReceivedWei, 18),
);
// **Which of the two evaluations actually pays is timing-dependent**, so
// "the second one cost nothing" is not an invariant and asserting it fails
// about half the time. What *is* invariant: across both attempts the agent is
// charged the price at most once. Anything above it would be a double charge,
// and zero means the sweep got there first.
// The agent also pays gas for its own registration and mandate writes, so an
// exact equality here is wrong. What matters is that the *price* was taken once
// and not twice: anything at or under the price plus a little gas is one
// purchase; anything near twice the price is two.
const agentNow = await client.getBalance({ address: agent.agentEvmAddress as Address });
const spent = agentBefore - agentNow;
const price = unitsToWei(CHEAP_UNITS);
check(
  "the agent was charged the price at most once",
  spent < price + unitsToWei(50_000n),
  `${formatUnits(spent, 18)} left the wallet against a ${formatUnits(price, 18)} price`,
);

// The whole point: the agent pays, the buyer owns.
let held = await keysHeldBy(buyerAddr as Address);
for (let i = 0; i < 30 && held.length === 0; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  held = await keysHeldBy(buyerAddr as Address);
}
check("a GameKey reached the buyer", held.length === 1, held.length);
check("for the right game", held[0]?.gameId === gameIdFor(cheap.game.id), held[0]?.gameId);
const agentKeys = await keysHeldBy(agent.agentEvmAddress as Address);
check("and the agent kept no key for itself", agentKeys.length === 0, agentKeys.length);

const keyRows = await db.query.gameKeys.findMany({ where: eq(gameKeys.gameId, cheap.game.id) });
check("the key is recorded against the buyer, not the payer", getAddress(keyRows[0]!.ownerAccountId as Address) === getAddress(buyerAddr));

// ── and refuses above the mandate ──────────────────────────────────────────
console.log("\n== a game above its published ceiling is refused ==");
const dear = await publishGame(DEAR_UNITS, "dear");
await db.insert(wishlistItems).values({
  userId: buyer!.id,
  gameId: dear.game.id,
  // Asking for more than the agent's published ceiling. The ceiling is the
  // highest want, so this would raise it — which is exactly why the test
  // re-reads it rather than assuming.
  agentMaxUnits: Number(DEAR_UNITS),
});

const beforeDear = await client.getBalance({ address: agent.agentEvmAddress as Address });
// Long enough for several rounds to have considered it and declined.
await new Promise((r) => setTimeout(r, 20_000));
const refreshed = await reload();

const dearSales = await db.query.sales.findMany({ where: eq(sales.gameId, dear.game.id) });
const ceilingNow = await ceilingFromChain(refreshed!);
console.log(`   published ceiling is still ${ceilingNow} units, the game costs ${DEAR_UNITS}`);
check("the expensive game was not bought", dearSales.length === 0, dearSales.length);
check(
  "nothing left the agent's wallet for it",
  (await client.getBalance({ address: agent.agentEvmAddress as Address })) === beforeDear,
);
check(
  "because the ceiling on chain had not been raised",
  ceilingNow !== null && ceilingNow < Number(DEAR_UNITS),
  ceilingNow,
);

console.log(`\nagent ${agent.id}, ERC-8004 token ${funded?.erc8004AgentId}`);
console.log(`explorer: https://explorer.testnet.arc.io/token/${env.ARC_IDENTITY_REGISTRY}/instance/${funded?.erc8004AgentId}`);
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
