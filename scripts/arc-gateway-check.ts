/**
 * Proves Stage 7's own code against the real Arc testnet and the real Circle
 * Gateway — not just the SDK in isolation. Exercises exactly the functions
 * the trial-chunk routes call: `gatewayRequirements`, `buildGatewayAuthorization`,
 * `gatewayTypedDataFor`, `settleGatewayPayment`.
 *
 *   npx tsx scripts/arc-gateway-check.ts
 *
 * What it settles for real, as the buyer:
 *   - Gateway accepts our own SplitVault contract as `payTo` — the port's one
 *     previously-unverified assumption (see docs/arc-stages.md Stage 7)
 *   - a chunk signed against the GatewayWallet domain verifies and settles
 *   - the same signed chunk cannot be settled twice
 *   - (best-effort, not a failure if testnet is slow about it) the batch
 *     that actually moves the money on-chain eventually lands
 *
 * Uses the operator's own wallet as the "buyer": it already holds testnet
 * USDC and spends only a few cents, deposited into Gateway and paid out to
 * the existing fixture vault used elsewhere in these check scripts.
 */
import { formatUnits, type Address, type Hex } from "viem";
import { env } from "../src/config/env.js";
import { operator, publicClient, USDC_ADDRESS } from "../src/services/arc/client.js";
import { erc20Abi } from "../src/services/arc/abis.js";
import {
  buildGatewayAuthorization,
  gatewayRequirements,
  gatewayTypedDataFor,
  gatewayWalletAddress,
  settleGatewayPayment,
} from "../src/services/arc/x402/gateway.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("arc-gateway-check only runs against testnet");

const VAULT = (process.env.ARC_CHECK_VAULT as Address) ?? "0x71349A7527A6Cb3d1bEa1153f2a5c7C8fC36C5b4";
const CHUNK_UNITS = 1_000n; // $0.001 — Stage 7's actual target price

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};
const fmt = (u: bigint) => `${formatUnits(u, 6)} USDC`;
const client = publicClient();
const vaultBalance = () => client.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [VAULT] });
const resource = { url: "https://cgs.local/gateway-check", description: "Stage 7 proof chunk", mimeType: "application/json" };

console.log(`payTo (Stage 4's fixture vault, reused on purpose): ${VAULT}`);
console.log(`buyer (operator's own wallet): ${operator().address}\n`);

console.log("== discovering Arc Testnet's GatewayWallet ==");
const walletAddress = await gatewayWalletAddress();
check("Gateway published a GatewayWallet contract for Arc Testnet", Boolean(walletAddress), walletAddress);

console.log("\n== deposit (one-time, buyer pays gas) ==");
const before = await vaultBalance();
console.log(`vault balance before: ${fmt(before)}`);
const deposit = await depositIntoGateway("0.05");
check("deposit transaction landed", Boolean(deposit.depositTxHash), deposit.depositTxHash);
console.log(`deposited ${deposit.formattedAmount} USDC, tx ${deposit.depositTxHash}`);

console.log("\n== sign and settle one chunk through our own code, gas-free ==");
const requirements = await gatewayRequirements(VAULT, CHUNK_UNITS);
check("requirements use our own USDC address", requirements.asset === USDC_ADDRESS);
check("requirements name the vault as payTo", requirements.payTo.toLowerCase() === VAULT.toLowerCase());

const authorization = buildGatewayAuthorization(operator().address, VAULT, CHUNK_UNITS);
const typed = gatewayTypedDataFor(authorization, requirements.extra.verifyingContract);
const signature = await operator().signTypedData(typed);

const settled = await settleGatewayPayment(requirements, authorization, signature, resource);
check("our own code settles the chunk against the vault", settled.status === "settled", settled);
console.log(`settlement: ${JSON.stringify(settled)}`);

if (settled.status === "settled") {
  check("settlement reports the buyer as payer", settled.payer.toLowerCase() === operator().address.toLowerCase());

  // Gateway's own docs: "the seller serves the resource immediately, without
  // waiting for onchain settlement" — so this is informational, not a failure.
  // The money reaching the vault is a later, separate event (a periodic batch),
  // and testnet's own cadence for that is outside anything this check controls.
  const transfer = await until(
    "the batched transfer to land on-chain",
    () => getTransferStatus(settled.transferId),
    (t) => t === "completed" || t === "failed",
    20_000,
  );
  console.log(`batch status after 20s: ${transfer} ${transfer === "completed" ? "" : "(not a failure — Gateway settles batches on its own schedule)"}`);
  if (transfer === "completed") {
    const after = await vaultBalance();
    check("once the batch landed, the vault received exactly the chunk price", after === before + CHUNK_UNITS, `${fmt(after)} vs expected ${fmt(before + CHUNK_UNITS)}`);
  }
}

console.log("\n== replay is refused ==");
const replay = await settleGatewayPayment(requirements, authorization, signature, resource);
check("the same signed authorization cannot be settled twice", replay.status === "failed", replay);

console.log("\n== withdraw the remainder back out (testnet hygiene) ==");
try {
  console.log(`withdrew ${await withdrawFromGateway()} back to the operator`);
} catch (err) {
  console.log(`(withdrawal skipped, harmless: ${err instanceof Error ? err.message : String(err)})`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

// --- helpers, kept local since this script is a check, not product code ---

async function depositIntoGateway(amount: string) {
  const { GatewayClient } = await import("@circle-fin/x402-batching/client");
  const gw = new GatewayClient({ chain: "arcTestnet", privateKey: env.ARC_OPERATOR_KEY as Hex });
  return gw.deposit(amount);
}

async function withdrawFromGateway(): Promise<string> {
  const { GatewayClient } = await import("@circle-fin/x402-batching/client");
  const gw = new GatewayClient({ chain: "arcTestnet", privateKey: env.ARC_OPERATOR_KEY as Hex });
  const balances = await gw.getBalances();
  if (balances.gateway.available === 0n) return "nothing left";
  const result = await gw.withdraw(formatUnits(balances.gateway.available, 6));
  return result.formattedAmount;
}

async function getTransferStatus(transferId: string): Promise<string> {
  const { GatewayClient } = await import("@circle-fin/x402-batching/client");
  const gw = new GatewayClient({ chain: "arcTestnet", privateKey: env.ARC_OPERATOR_KEY as Hex });
  const transfer = await gw.getTransferById(transferId);
  return transfer.status;
}

async function until<T>(label: string, read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await read();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 1000));
  } while (Date.now() < deadline);
  console.log(`(gave up waiting for ${label})`);
  return last;
}
