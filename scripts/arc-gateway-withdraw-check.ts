/**
 * Proves services/arc/x402/gatewayWithdraw.ts against the real Arc testnet
 * and the real Circle Gateway — the half of Stage 7 that was flagged as not
 * built: a depositor had no way to get an unused Gateway deposit back out.
 *
 *   npm run dev              # in one terminal
 *   npx tsx scripts/arc-gateway-withdraw-check.ts
 *
 * Plays the buyer with a raw key rather than Privy, same reasoning as every
 * other check script here: the server must never be able to sign on a
 * buyer's behalf (CGS-server/CLAUDE.md), so the thing actually under test —
 * `prepareGatewayWithdraw` / `completeGatewayWithdraw` — is exercised through
 * exactly the two calls a browser would make, and the final on-chain mint is
 * sent by this script's own "buyer" wallet, paying its own gas, the same way
 * a browser would.
 *
 * Deposits via `@circle-fin/x402-batching`'s `GatewayClient` — test setup
 * only, not the code under test, same as arc-gateway-check.ts already does.
 */
import { randomUUID } from "node:crypto";
import { formatUnits, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config/env.js";
import { arcChain, confirm, feeOverrides, operator, unitsToWei, walletClient } from "../src/services/arc/client.js";
import { getUsdcUnits } from "../src/services/arc/reads.js";
import { gatewayAvailableUnits } from "../src/services/arc/x402/gateway.js";
import {
  burnIntentForWire,
  completeGatewayWithdraw,
  MAX_FEE_UNITS,
  prepareGatewayWithdraw,
  withdrawableUnits,
} from "../src/services/arc/x402/gatewayWithdraw.js";
import { AppError } from "../src/lib/errors.js";

// `Errors.validationFailed`'s own `.message` is the same generic sentence for
// every field error by design — the real reason lives in `.details`. Reading
// `.message` here would make every validation failure look identical.
const reason = (err: unknown): string => (err instanceof AppError ? JSON.stringify(err.details ?? err.message) : String(err));

if (env.ARC_NETWORK !== "testnet") throw new Error("arc-gateway-withdraw-check only runs against testnet");

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};
const fmt = (u: bigint) => `${formatUnits(u, 6)} USDC`;
const until = async <T>(label: string, read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 20_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await read();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 1000));
  } while (Date.now() < deadline);
  console.log(`(gave up waiting for ${label})`);
  return last;
};

const buyerKey = generatePrivateKey();
const buyer = privateKeyToAccount(buyerKey);
const userId = randomUUID();
const DEPOSIT_UNITS = 50_000n; // 0.05 USDC
const FUND_UNITS = 100_000n; // deposit + gas for the deposit's two txs and the final mint

console.log(`buyer (fresh, raw key — standing in for a Privy wallet): ${buyer.address}\n`);

console.log("== funding and depositing into Gateway (test setup, not the code under test) ==");
await confirm(
  await walletClient().sendTransaction({
    account: operator(),
    chain: arcChain(),
    to: buyer.address,
    value: unitsToWei(FUND_UNITS),
    ...(await feeOverrides()),
  }),
);
check("buyer funded", (await getUsdcUnits(buyer.address)) === FUND_UNITS);

const { GatewayClient } = await import("@circle-fin/x402-batching/client");
const gw = new GatewayClient({ chain: "arcTestnet", privateKey: buyerKey });
const deposit = await gw.deposit(formatUnits(DEPOSIT_UNITS, 6));
check("deposit transaction landed", Boolean(deposit.depositTxHash), deposit.depositTxHash);

const available = await until(
  "the deposit to appear in Gateway's own balance",
  () => gatewayAvailableUnits(buyer.address),
  (u) => u >= DEPOSIT_UNITS,
);
check("Gateway shows the deposit as available", available >= DEPOSIT_UNITS, available);

console.log("\n== validation before touching the chain ==");
// Circle takes its fee on top of the amount signed for, so the whole balance
// can never come out; asking for exactly all of it must be refused here, before
// anyone signs, not at Circle afterwards.
for (const [label, ask] of [
  ["more than the balance", available + 1_000_000n],
  ["exactly the whole balance", available],
] as const) {
  try {
    await prepareGatewayWithdraw(userId, buyer.address, ask);
    check(`withdrawing ${label} is refused at prepare`, false);
  } catch (err) {
    check(`withdrawing ${label} is refused at prepare`, /can come out of Gateway/i.test(reason(err)), reason(err));
  }
}

console.log("\n== prepare, sign, complete — exactly what a browser does ==");
const WITHDRAW_UNITS = DEPOSIT_UNITS / 2n;
const prepared = await prepareGatewayWithdraw(userId, buyer.address, WITHDRAW_UNITS);
check("prepare names the requested amount", prepared.amountUnits === WITHDRAW_UNITS);

const signature = (await buyer.signTypedData(
  prepared.typedData as unknown as Parameters<typeof buyer.signTypedData>[0],
)) as Hex;

console.log("\n== a signature from the wrong wallet is refused ==");
const impostor = privateKeyToAccount(generatePrivateKey());
try {
  // Needs its own prepare — completing consumes the real one regardless of outcome.
  const decoy = await prepareGatewayWithdraw(userId, buyer.address, WITHDRAW_UNITS);
  const wrongSig = (await impostor.signTypedData(decoy.typedData as unknown as Parameters<typeof impostor.signTypedData>[0])) as Hex;
  await completeGatewayWithdraw(userId, decoy.withdrawId, wrongSig);
  check("a signature from the wrong wallet is refused", false);
} catch (err) {
  check("a signature from the wrong wallet is refused", err instanceof Error && /signature/i.test(err.message), err);
}

const walletBefore = await getUsdcUnits(buyer.address);
const completed = await completeGatewayWithdraw(userId, prepared.withdrawId, signature);
check("complete reports the requested amount", completed.amountUnits === WITHDRAW_UNITS, completed.amountUnits);
check("complete hands back a mint transaction", Boolean(completed.mintTransaction?.data), completed.mintTransaction);

console.log("\n== redeeming the attestation on-chain, buyer pays its own gas ==");
const mintHash = await walletClient().sendTransaction({
  account: buyer,
  chain: arcChain(),
  to: completed.mintTransaction.to,
  data: completed.mintTransaction.data,
  ...(await feeOverrides()),
});
const receipt = await confirm(mintHash);
check("the mint transaction succeeded", receipt.status === "success", receipt.status);

const walletAfter = await getUsdcUnits(buyer.address);
check(
  "the withdrawn amount reached the buyer's own wallet",
  walletAfter >= walletBefore + WITHDRAW_UNITS - 10_000n, // allows for Circle's real fee and this tx's own gas
  `before ${fmt(walletBefore)}, after ${fmt(walletAfter)}, expected roughly +${fmt(WITHDRAW_UNITS)}`,
);

const availableAfter = await until(
  "Gateway's balance to reflect the withdrawal",
  () => gatewayAvailableUnits(buyer.address),
  (u) => u <= available - WITHDRAW_UNITS + 1_000n,
);
check("Gateway's available balance dropped by the withdrawn amount", availableAfter <= available - WITHDRAW_UNITS + 1_000n, availableAfter);

console.log("\n== the same signed withdrawal cannot be completed twice ==");
try {
  await completeGatewayWithdraw(userId, prepared.withdrawId, signature);
  check("a consumed withdrawId is refused on reuse", false);
} catch (err) {
  check("a consumed withdrawId is refused on reuse", /expired or was already used/i.test(reason(err)), reason(err));
}

console.log("\n== 'withdraw everything', over a real JSON round trip (what the browser actually does) ==");
// Both of these shipped broken because the first half of this script never
// exercised them: the default amount was never run, and the service was called
// directly so nothing ever tried to serialise a bigint over HTTP.
const remaining = await until(
  "the first withdrawal to settle in Gateway's balance",
  () => gatewayAvailableUnits(buyer.address),
  (u) => u <= available - WITHDRAW_UNITS + 1_000n,
);
const everything = await prepareGatewayWithdraw(userId, buyer.address);
check("omitting the amount asks for balance minus the fee ceiling", everything.amountUnits === withdrawableUnits(remaining), `${everything.amountUnits} vs ${withdrawableUnits(remaining)}`);

let wire: typeof everything.typedData | undefined;
try {
  wire = JSON.parse(JSON.stringify(burnIntentForWire(everything.typedData)));
  check("the prepare payload survives JSON serialisation", true);
} catch (err) {
  check("the prepare payload survives JSON serialisation", false, err);
}
const wireSignature = (await buyer.signTypedData(wire as unknown as Parameters<typeof buyer.signTypedData>[0])) as Hex;
const everythingDone = await completeGatewayWithdraw(userId, everything.withdrawId, wireSignature);
check("a signature made over the parsed JSON strings is accepted", everythingDone.amountUnits === everything.amountUnits);

const walletBeforeAll = await getUsdcUnits(buyer.address);
const mintAll = await walletClient().sendTransaction({
  account: buyer, chain: arcChain(), to: everythingDone.mintTransaction.to, data: everythingDone.mintTransaction.data, ...(await feeOverrides()),
});
check("the full-withdrawal mint succeeded", (await confirm(mintAll)).status === "success");
check("only dust of at most the fee ceiling is left in Gateway", (await until(
  "Gateway's balance to reflect the full withdrawal",
  () => gatewayAvailableUnits(buyer.address),
  (u) => u <= MAX_FEE_UNITS,
)) <= MAX_FEE_UNITS);
check("the wallet received it", (await getUsdcUnits(buyer.address)) > walletBeforeAll);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
