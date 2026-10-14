/**
 * The fixes made after the pre-mainnet review, proven rather than assumed.
 *
 *   npx tsx scripts/arc-hardening-check.ts      # needs a database and a funded testnet operator
 *
 *   - the server refuses to boot on mainnet with a missing or unsafe setting
 *   - an agent whose refund fails goes back to active, so the refund can be retried
 *   - a game key whose mint never finished is minted by the retry job, exactly once
 *
 * The vault-squatting fix, the claim guard and the factory itself are covered by
 * `arc:check:publish`, which needs the operator-only factory deployed.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config/env.js";
import { db } from "../src/db/client.js";
import { gameKeys, games, studios, users, wishlistAgents } from "../src/db/schema.js";
import { arcChain, confirm, feeOverrides, operator, unitsToWei, walletClient } from "../src/services/arc/client.js";
import { keysHeldBy, ownsGame } from "../src/services/arc/keys.js";
import { gameIdFor } from "../src/services/arc/registry.js";
import { retireAgent } from "../src/services/agent/wallet.js";
import { retryStuckMints } from "../src/services/games/fulfilArc.js";
import { keyAddress } from "../src/services/arc/client.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("this only runs against testnet");

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};

// ── 1. the mainnet boot guard ───────────────────────────────────────────────
console.log("== mainnet refuses to boot with an unsafe setting ==");
const dir = mkdtempSync(join(tmpdir(), "cgs-env-"));
try {
  // Everything the server needs except the chain settings under test, so a
  // failure below is about those and nothing else.
  const base = readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => !/^(ARC_|CIRCLE_API_KEY|TESTNET_FAUCET|DEV_FAUCET)/.test(l))
    .join("\n");
  const key = generatePrivateKey();
  const operatorAddress = privateKeyToAccount(key).address;
  const other = privateKeyToAccount(generatePrivateKey()).address;
  const contract = privateKeyToAccount(generatePrivateKey()).address;
  const good: Record<string, string> = {
    ARC_NETWORK: "mainnet",
    ARC_RPC_URL: "https://rpc.mainnet.arc.io",
    ARC_OPERATOR_KEY: key,
    ARC_GAME_REGISTRY: contract,
    ARC_GAME_KEY: contract,
    ARC_VAULT_FACTORY: contract,
    ARC_PLATFORM_PAYOUT: other,
    CIRCLE_API_KEY: "LIVE_API_KEY:aaaa:bbbb",
  };
  const boots = (overrides: Record<string, string | null>) => {
    const settings = { ...good, ...overrides };
    const file = join(dir, `${randomUUID()}.env`);
    writeFileSync(
      file,
      base + "\n" + Object.entries(settings).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
    );
    const r = spawnSync("npx", ["tsx", "-e", 'import "./src/config/env.ts"'], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DOTENV_CONFIG_PATH: file },
      encoding: "utf8",
    });
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
  };
  check("a complete mainnet configuration boots", boots({}).ok, boots({}).out.slice(-300));
  check("no platform payout is refused", !boots({ ARC_PLATFORM_PAYOUT: null }).ok);
  check("a payout equal to the operator is refused", !boots({ ARC_PLATFORM_PAYOUT: operatorAddress }).ok);
  check("a missing Circle key is refused", !boots({ CIRCLE_API_KEY: null }).ok);
  check("a TEST Circle key is refused on mainnet", !boots({ CIRCLE_API_KEY: "TEST_API_KEY:aaaa:bbbb" }).ok);
  check("a missing contract address is refused", !boots({ ARC_VAULT_FACTORY: null }).ok);
  check("a missing RPC is refused", !boots({ ARC_RPC_URL: null }).ok);
  check("a missing operator key is refused", !boots({ ARC_OPERATOR_KEY: null }).ok);
  check("testnet is unaffected by any of it", boots({ ARC_NETWORK: "testnet", ARC_PLATFORM_PAYOUT: null, CIRCLE_API_KEY: null, ARC_RPC_URL: null }).ok);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── 2. an agent whose refund fails is not left ended with money inside ──────
console.log("\n== a failed refund puts the agent back ==");
const buyerKey = generatePrivateKey();
const [buyer] = await db
  .insert(users)
  .values({
    privyDid: `did:privy:hard-${randomUUID()}`,
    email: `hard-${randomUUID().slice(0, 8)}@cgs.test`,
    evmAddress: privateKeyToAccount(buyerKey).address,
    privyWalletId: `hard-${randomUUID()}`,
  })
  .returning();
const agentAccount = privateKeyToAccount(generatePrivateKey());
// Holds real money, so the refund is attempted, but its wallet id is one Privy
// has never heard of, so the attempt fails the way a transient Privy error would.
await confirm(
  await walletClient().sendTransaction({ account: operator(), chain: arcChain(), to: agentAccount.address, value: unitsToWei(100_000n), ...(await feeOverrides()) }),
);
const [agent] = await db
  .insert(wishlistAgents)
  .values({
    buyerUserId: buyer!.id,
    agentWalletId: `no-such-wallet-${randomUUID()}`,
    agentEvmAddress: agentAccount.address,
    agentPublicKeyHex: "00",
    status: "watching",
  })
  .returning();
const failed = await retireAgent(agent!, "cancelled").then(
  () => null,
  (err: unknown) => err,
);
check("the refund failure is reported to the caller", failed !== null);
const afterFail = await db.query.wishlistAgents.findFirst({ where: eq(wishlistAgents.id, agent!.id) });
check("the agent is back to watching, not stranded as cancelled", afterFail?.status === "watching", afterFail?.status);
const again = await retireAgent(afterFail!, "cancelled").then(
  () => "ok",
  () => "threw again",
);
check("so a retry reaches the refund again instead of being a no-op", again === "threw again", again);
await db.delete(wishlistAgents).where(eq(wishlistAgents.id, agent!.id));

// ── 3. a key whose mint never finished is minted once, by the retry job ─────
console.log("\n== stuck mints are retried, once ==");
const [studioOwner] = await db
  .insert(users)
  .values({ privyDid: `did:privy:mint-${randomUUID()}`, email: `mint-${randomUUID().slice(0, 8)}@cgs.test`, evmAddress: privateKeyToAccount(generatePrivateKey()).address, privyWalletId: `mint-${randomUUID()}` })
  .returning();
const [studio] = await db.insert(studios).values({ ownerUserId: studioOwner!.id, name: "Mint Retry", slug: `mint-${randomUUID().slice(0, 8)}` }).returning();
const [game] = await db
  .insert(games)
  .values({ studioId: studio!.id, slug: `mint-game-${randomUUID().slice(0, 8)}`, title: "Mint Retry Game", coverSeed: 1, priceUnits: 10_000, priceAsset: "0x3600000000000000000000000000000000000000", status: "draft" })
  .returning();
const owner = privateKeyToAccount(generatePrivateKey()).address;
const [row] = await db
  .insert(gameKeys)
  .values({ tokenId: keyAddress(), gameId: game!.id, ownerAccountId: owner, mintStatus: "failed" })
  .returning();
const holds = async () => (await ownsGame(owner, gameIdFor(game!.id))).owned;

check("before the job the buyer holds no key on chain", !(await holds()));
await retryStuckMints();
check("a row seen stuck for the first time is not touched yet", !(await holds()));
const first = await db.query.gameKeys.findFirst({ where: eq(gameKeys.id, row!.id) });
check("and is still marked failed", first?.mintStatus === "failed", first?.mintStatus);
const retried = await retryStuckMints();
check("the second pass retries it", retried === 1, retried);
check("the buyer now holds the key on chain", await holds());
const done = await db.query.gameKeys.findFirst({ where: eq(gameKeys.id, row!.id) });
check("the row is confirmed with its serial and transaction", done?.mintStatus === "confirmed" && done.serial !== null && !!done.txId, JSON.stringify(done));
await retryStuckMints();
await retryStuckMints();
const held = (await keysHeldBy(getAddress(owner))).filter((k) => k.gameId === gameIdFor(game!.id));
check("more passes never mint a second key", held.length === 1, held.length);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
