/**
 * Proves the src/services/arc layer against the real deployed contracts on
 * Arc testnet. Exits non-zero if anything is off. Spends a few cents of
 * testnet USDC, and refuses to run against mainnet.
 *
 *   npx tsx scripts/arc-chain-check.ts
 *
 * Exercises every function listed in services/arc/abis.ts, so a drift between
 * this repo and CGS-contracts shows up here rather than in production.
 */
import { randomUUID } from "node:crypto";
import { createPublicClient, createWalletClient, formatUnits, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config/env.js";
import { gameKeyAbi, gameRegistryAbi, splitVaultAbi, erc20Abi } from "../src/services/arc/abis.js";
import {
  arcChain,
  feeOverrides,
  keyAddress,
  MIN_FEE_PER_GAS,
  operator,
  publicClient,
  registryAddress,
  unitsToWei,
  USDC_ADDRESS,
  walletClient,
  weiToUnits,
  confirm,
} from "../src/services/arc/client.js";
import {
  announceBuild,
  announcePrice,
  delistListing,
  gameIdFor,
  getListing,
  publishListing,
  relistListing,
  uuidFromGameId,
} from "../src/services/arc/registry.js";
import { keysHeldBy, mintKey, ownsGame } from "../src/services/arc/keys.js";
import { getVaultState } from "../src/services/arc/vault.js";
import { getBlockNumber, getListingEvents, getNativeWei, getTxStatus, getUsdcUnits } from "../src/services/arc/reads.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("arc-chain-check only runs against testnet");

// The canonical Stage 2 vault: 95% a studio, 5% platform.
const VAULT: Address = (process.env.ARC_CHECK_VAULT as Address) ?? "0x71349A7527A6Cb3d1bEa1153f2a5c7C8fC36C5b4";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
}

// True only if the call fails AND the failure mentions `needle`.
async function failsWith(run: () => unknown, needle: string): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (err) {
    const cause = (err as { cause?: { message?: string; shortMessage?: string } }).cause;
    const text = err instanceof Error ? [err.name, err.message, cause?.message, cause?.shortMessage].join(" ") : String(err);
    return text.includes(needle);
  }
}

// A read straight after a confirmed write can land on a node that has not seen
// the block yet. Poll for the expected answer instead of trusting one read, and
// count how often the first read was stale so the docs can say how often.
let staleFirstReads = 0;
async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let value = await read();
  if (!done(value)) staleFirstReads++;
  while (!done(value) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 300));
    value = await read();
  }
  return value;
}

const transferAbi = [
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const client = publicClient();
const me = operator().address;

console.log("\n== pure helpers ==");
const uuid = randomUUID();
const gameId = gameIdFor(uuid);
check("gameIdFor is 32 bytes", gameId.length === 66, gameId);
check("uuid survives the round trip", uuidFromGameId(gameId) === uuid, uuidFromGameId(gameId));
check("a non-uuid gameId maps to null", uuidFromGameId(("0x" + "ab".repeat(32)) as Hex) === null);
check("a malformed uuid throws", await failsWith(() => gameIdFor("nope"), "not a uuid"));
check("6dp <-> 18dp conversion round-trips", weiToUnits(unitsToWei(3_000_000n)) === 3_000_000n);
check("sub-unit dust rounds down, never up", weiToUnits(unitsToWei(5n) + 999_999_999_999n) === 5n);
check("fee clamp never goes under the 20 Gwei floor", (await feeOverrides()).maxFeePerGas >= MIN_FEE_PER_GAS);

console.log("\n== network and configuration ==");
check("chain id is Arc testnet", (await client.getChainId()) === 5042002 && arcChain().id === 5042002);
check("multicall3 is deployed", ((await client.getCode({ address: arcChain().contracts.multicall3.address })) ?? "0x") !== "0x");
check("USDC reports 6 decimals", (await client.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "decimals" })) === 6);
check("USDC symbol", (await client.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "symbol" })) === "USDC");
check(
  "ARC_OPERATOR_KEY is GameRegistry's immutable operator",
  (await client.readContract({ address: registryAddress(), abi: gameRegistryAbi, functionName: "operator" })) === me,
);
check(
  "ARC_OPERATOR_KEY is GameKey's immutable minter",
  (await client.readContract({ address: keyAddress(), abi: gameKeyAbi, functionName: "minter" })) === me,
);
const nativeWei = await getNativeWei(me);
const erc20Units = await getUsdcUnits(me);
check("native and ERC-20 balances are one balance", weiToUnits(nativeWei) === erc20Units, `${nativeWei} vs ${erc20Units}`);
console.log(`      operator ${me} holds ${formatUnits(nativeWei, 18)} USDC`);
check("operator can afford the run", nativeWei > parseEther("0.05"));

console.log("\n== split vault (read) ==");
const vault = await getVaultState(VAULT);
check("vault has two payees", vault.payees.length === 2, vault.payees.length);
check("bps sum to exactly 10,000", vault.payees.reduce((n, p) => n + p.bps, 0) === 10_000);
check("platform holds 500 bps", vault.payees.some((p) => p.bps === 500));
check("remainder goes to the largest share", vault.payees.find((p) => p.address === vault.remainderPayee)?.bps === 9_500);
check(
  "every payee's owed sums to everything received",
  vault.payees.reduce((n, p) => n + p.owedWei, 0n) === vault.totalReceivedWei,
);

console.log("\n== registry (write + read) ==");
const startBlock = await getBlockNumber();
const gas = new Map<string, bigint>();
const spend = async (label: string, tx: { txHash: Hex }) => {
  const r = await client.getTransactionReceipt({ hash: tx.txHash });
  gas.set(label, r.gasUsed * r.effectiveGasPrice);
  return r;
};

const published = await publishListing({ gameId, slug: `check-${uuid.slice(0, 8)}`, priceUnits: 3_000_000n, vault: VAULT, buildCid: "bafycheckbuild1" });
await spend("publish", published);
const listing = await getListing(gameId);
check("published game points at its vault", listing.published && listing.vault === VAULT && !listing.delisted, JSON.stringify(listing));
check("an unpublished game reads as unpublished", !(await getListing(gameIdFor(randomUUID()))).published);

const endsAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
await spend("setPrice", await announcePrice(gameId, 3_000_000n, 1_500_000n, endsAt));
await spend("updateBuild", await announceBuild(gameId, 2, "bafycheckbuild2"));
await spend("delist", await delistListing(gameId));
check("delisted flag is set", (await getListing(gameId)).delisted);
check("delisting leaves the vault alone", (await getListing(gameId)).vault === VAULT);
await spend("relist", await relistListing(gameId, 1_500_000n));
check("relist clears the flag", !(await getListing(gameId)).delisted);

check(
  "publishing twice surfaces the contract's own error",
  await failsWith(() => publishListing({ gameId, slug: "dup", priceUnits: 1n, vault: VAULT, buildCid: "x" }), "AlreadyPublished"),
);
check(
  "pricing an unpublished game surfaces NotPublished",
  await failsWith(() => announcePrice(gameIdFor(randomUUID()), 1n, 2n), "NotPublished"),
);

console.log("\n== keys (write + read) ==");
const buyerKey = generatePrivateKey();
const buyer = privateKeyToAccount(buyerKey);
const friend = privateKeyToAccount(generatePrivateKey());
const otherGame = gameIdFor(randomUUID());

// Three mints fired at once from one operator: proves the nonce handling holds
// up under the exact situation concurrent purchases create.
const [m1, m2, m3] = await Promise.all([
  mintKey(buyer.address, gameId),
  mintKey(buyer.address, otherGame),
  mintKey(friend.address, otherGame),
]);
check("three concurrent mints all landed", [m1, m2, m3].every((m) => m.tokenId > 0n));
check("token ids are distinct", new Set([m1.tokenId, m2.tokenId, m3.tokenId]).size === 3);
await spend("mint", m1);

// Heavier version of the above: eight at once, several landing on the same
// holder. The first version of this layer sized gas per transaction and lost one
// of three to out-of-gas here, in two runs out of three.
const stressHolders = [buyer.address, friend.address, privateKeyToAccount(generatePrivateKey()).address, privateKeyToAccount(generatePrivateKey()).address];
const stress = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => mintKey(stressHolders[i % 4]!, i % 2 ? gameId : otherGame)));
check("eight concurrent mints all landed", stress.every((r) => r.status === "fulfilled"), stress.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason?.message).join(" | "));

const expectedBuyerKeys = 2 + stress.filter((r, i) => r.status === "fulfilled" && i % 4 === 0).length;
const held = await eventually(() => keysHeldBy(buyer.address), (h) => h.length === expectedBuyerKeys);
check("buyer holds every key minted to them", held.length === expectedBuyerKeys, `${held.length} vs ${expectedBuyerKeys}`);
const own = await eventually(() => ownsGame(buyer.address, gameId), (o) => o.owned);
check("ownsGame is true for a game the buyer holds", own.owned && own.tokenId === m1.tokenId, JSON.stringify(own, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
check("ownsGame is false for a game they don't", !(await ownsGame(buyer.address, gameIdFor(randomUUID()))).owned);
check("a wallet with no keys holds none", (await keysHeldBy(privateKeyToAccount(generatePrivateKey()).address)).length === 0);
check("each key records the game it belongs to", held.some((k) => k.gameId === gameId) && held.some((k) => k.gameId === otherGame));

// Owner moves the key, and the check follows it. This is the case a database
// cache could never get right.
const fundHash = await walletClient().sendTransaction({ account: operator(), chain: arcChain(), to: buyer.address, value: parseEther("0.01"), ...(await feeOverrides()) });
await confirm(fundHash);
await spend("fund buyer", { txHash: fundHash });
const buyerWallet = createWalletClient({ account: buyer, chain: arcChain(), transport: http() });
const { request: transferReq } = await client.simulateContract({
  account: buyer,
  address: keyAddress(),
  abi: transferAbi,
  functionName: "transferFrom",
  args: [buyer.address, friend.address, m1.tokenId],
  ...(await feeOverrides()),
});
await confirm(await buyerWallet.writeContract(transferReq));
check("after a transfer the seller no longer owns the game", !(await eventually(() => ownsGame(buyer.address, gameId), (o) => !o.owned)).owned);
const friendKeys = await eventually(() => keysHeldBy(friend.address), (k) => k.some((x) => x.tokenId === m1.tokenId));
check("after a transfer the recipient holds that exact key", friendKeys.some((k) => k.tokenId === m1.tokenId && k.gameId === gameId));
check("and ownsGame agrees for them", (await ownsGame(friend.address, gameId)).owned);

console.log("\n== reading the public log ==");
const head = await getBlockNumber();
const mine = (await getListingEvents(startBlock, head)).filter((e) => e.gameId === gameId);
check("five registry events for this game, oldest first", mine.map((e) => e.kind).join() === "listed,price_changed,build_updated,delisted,relisted", mine.map((e) => e.kind).join());
const priced = mine.find((e) => e.kind === "price_changed");
check("price change carries from/to and the sale deadline", priced?.kind === "price_changed" && priced.fromUnits === 3_000_000n && priced.toUnits === 1_500_000n && priced.endsAt === endsAt);
const built = mine.find((e) => e.kind === "build_updated");
check("build update carries version and cid", built?.kind === "build_updated" && built.version === 2 && built.buildCid === "bafycheckbuild2");
const listed = mine.find((e) => e.kind === "listed");
check("listing carries slug, price, vault and cid", listed?.kind === "listed" && listed.vault === VAULT && listed.priceUnits === 3_000_000n && listed.buildCid === "bafycheckbuild1");

const wide = (await getListingEvents(head - 25_000n, head)).filter((e) => e.gameId === gameId);
check("a 25,000-block read (three windows) returns the same events", wide.length === mine.length, `${wide.length} vs ${mine.length}`);
// Pinned to one endpoint on purpose: through the fallback transport a provider
// that refuses the span just hands the request to one that allows it (Blockdaemon
// does), which hides the cap this windowing exists to respect.
const single = createPublicClient({ chain: arcChain(), transport: http("https://rpc.testnet.arc.io") });
check(
  "a single public endpoint refuses one 25,000-block request",
  await failsWith(() => single.getContractEvents({ address: registryAddress(), abi: gameRegistryAbi, fromBlock: head - 25_000n, toBlock: head }), "range"),
);

check("a mined transaction reads as success", (await getTxStatus(published.txHash)) === "success");
check("an unknown hash reads as not_found", (await getTxStatus(("0x" + "11".repeat(32)) as Hex)) === "not_found");

console.log(`\n      first read stale after a confirmed write: ${staleFirstReads} time(s)`);
console.log("\n== measured cost (ARC testnet, paid by the operator) ==");
for (const [label, wei] of gas) console.log(`      ${label.padEnd(12)} ${formatUnits(wei, 18)} USDC`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
