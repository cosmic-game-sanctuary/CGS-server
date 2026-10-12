/**
 * Proves services/wallet/withdraw.ts — moving money already in someone's own
 * wallet out to an address of their choosing — against the real Arc testnet.
 * Flagged as written-but-never-run in an older status note; this is that run.
 *
 * Not the vault-claim half of "how does a developer get paid" (that's
 * services/earnings/claims.ts, proven separately by arc-publish-check.ts's
 * three payees). This is the second half: once their share is in their own
 * wallet, this is the mechanism that gets it out to wherever they actually
 * want it — another wallet, an exchange deposit address, anywhere.
 *
 *   npm run dev              # in one terminal
 *   npx tsx scripts/arc-withdraw-check.ts
 */
import { randomUUID } from "node:crypto";
import { formatUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config/env.js";
import { arcChain, confirm, feeOverrides, operator, unitsToWei, walletClient } from "../src/services/arc/client.js";
import { getUsdcUnits } from "../src/services/arc/reads.js";
import { confirmWithdraw, consumeWithdrawIntent, GAS_RESERVE_UNITS, prepareWithdraw, transactionFor } from "../src/services/wallet/withdraw.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("arc-withdraw-check only runs against testnet");

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};
const fmt = (u: bigint) => `${formatUnits(u, 6)} USDC`;

// Stands in for "a developer's share, already claimed out of a game's
// SplitVault" — getting it there is claims.ts's job, proven elsewhere. This
// wallet's money is indistinguishable from claimed earnings once it's in a
// wallet; that's the whole point of them being the same asset.
const earnerKey = generatePrivateKey();
const earner = privateKeyToAccount(earnerKey);
const userId = randomUUID();
// A personal wallet somewhere outside this app — a MetaMask, an exchange
// deposit address, anything with its own key we don't manage.
const personalWallet = privateKeyToAccount(generatePrivateKey());
const FUND_UNITS = 200_000n; // 0.20 USDC

console.log(`earner (stands in for a developer's wallet): ${earner.address}`);
console.log(`personal wallet (outside this app entirely): ${personalWallet.address}\n`);

await confirm(
  await walletClient().sendTransaction({
    account: operator(), chain: arcChain(), to: earner.address, value: unitsToWei(FUND_UNITS), ...(await feeOverrides()),
  }),
);
check("earner funded, standing in for an already-claimed share", (await getUsdcUnits(earner.address)) === FUND_UNITS);

console.log("\n== refused: withdrawing to the same wallet ==");
try {
  await prepareWithdraw({ userId, from: earner.address, to: earner.address });
  check("withdrawing to yourself is refused", false);
} catch {
  check("withdrawing to yourself is refused", true);
}

console.log("\n== a partial withdrawal, explicit amount ==");
const PARTIAL_UNITS = 50_000n;
const partial = await prepareWithdraw({ userId, from: earner.address, to: personalWallet.address, amountUnits: PARTIAL_UNITS });
check("prepare names the requested amount", partial.amountUnits === PARTIAL_UNITS);
check("prepare names the real gas reserve", partial.reservedForGasUnits === GAS_RESERVE_UNITS);

const partialTx = transactionFor(partial);
const partialHash = await walletClient().sendTransaction({
  account: earner, chain: arcChain(), to: partialTx.to as `0x${string}`, value: BigInt(partialTx.value), ...(await feeOverrides()),
});
await confirm(partialHash);

// The real route's order: /withdraw/complete consumes the intent first, then
// confirms it against the chain. Mirrored here rather than calling
// confirmWithdraw directly on `partial`, which would skip the consume step
// the route actually depends on.
const consumedPartial = consumeWithdrawIntent(partial.id, userId);
check("consuming the intent returns it, once", consumedPartial?.id === partial.id);
const partialConfirm = await confirmWithdraw(consumedPartial!, partialHash);
check("confirm reports the real amount sent", partialConfirm.amountUnits === PARTIAL_UNITS);
check(
  "the personal wallet actually received it",
  (await getUsdcUnits(personalWallet.address)) === PARTIAL_UNITS,
  await getUsdcUnits(personalWallet.address),
);

console.log("\n== that same intent cannot be completed twice ==");
check("consuming an already-consumed intent returns nothing", consumeWithdrawIntent(partial.id, userId) === undefined);

console.log("\n== the rest, via the default 'send everything you can afford' ==");
const remainder = await getUsdcUnits(earner.address);
const full = await prepareWithdraw({ userId, from: earner.address, to: personalWallet.address });
check("omitting amountUnits sends balance minus the gas reserve", full.amountUnits === remainder - GAS_RESERVE_UNITS, `${fmt(full.amountUnits)} vs ${fmt(remainder - GAS_RESERVE_UNITS)}`);

const fullTx = transactionFor(full);
const fullHash = await walletClient().sendTransaction({
  account: earner, chain: arcChain(), to: fullTx.to as `0x${string}`, value: BigInt(fullTx.value), ...(await feeOverrides()),
});
await confirm(fullHash);
await confirmWithdraw(full, fullHash);
check(
  "the personal wallet now holds both withdrawals",
  (await getUsdcUnits(personalWallet.address)) === PARTIAL_UNITS + full.amountUnits,
  await getUsdcUnits(personalWallet.address),
);

console.log("\n== confirm refuses a transaction that doesn't match what was prepared ==");
try {
  // Re-use the already-sent partial transaction's hash against a fresh,
  // different intent — same shape as a client lying about which tx paid for it.
  const mismatchIntent = await prepareWithdraw({ userId, from: earner.address, to: personalWallet.address, amountUnits: 1_000n });
  await confirmWithdraw(mismatchIntent, partialHash);
  check("a mismatched transaction is refused", false);
} catch (err) {
  check("a mismatched transaction is refused", true, err instanceof Error ? err.message : err);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
