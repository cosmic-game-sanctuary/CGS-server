/**
 * When Circle's facilitator refuses our credentials, a purchase still settles.
 *
 *   CIRCLE_API_KEY=TEST_API_KEY:invalid:invalid npx tsx scripts/arc-direct-settle-check.ts
 *
 * Seen on mainnet on 2026-10-15: a live key that authenticates but answers
 * `403 forbidden` on /settle, which failed every purchase. The invalid key above
 * reproduces the refusal on testnet (401), so this goes through the real
 * `settlePayment`, not the fallback function alone.
 *
 * Proves:
 *   - the refusal really happens (so the check is not passing by accident)
 *   - the authorization still settles: buyer to vault, the exact price, the buyer
 *     holding no gas
 *   - the operator is the one who paid the gas
 *   - the same authorization cannot be settled twice
 */
import { randomBytes } from "node:crypto";
import { formatUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config/env.js";
import { arcChain, confirm, feeOverrides, operator, publicClient, unitsToWei, walletClient } from "../src/services/arc/client.js";
import { getUsdcUnits } from "../src/services/arc/reads.js";
import { buildAuthorization, isAuthorizationUsed } from "../src/services/arc/x402/authorization.js";
import { settlePayment } from "../src/services/arc/x402/facilitator.js";
import { signAuthorization } from "../src/services/arc/x402/payer.js";
import { buildRequirements } from "../src/services/arc/x402/requirements.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("this only runs against testnet");
if (!env.CIRCLE_API_KEY || !env.CIRCLE_API_KEY.includes("invalid")) {
  throw new Error("run with CIRCLE_API_KEY=TEST_API_KEY:invalid:invalid so Circle refuses the request");
}

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};
const fmt = (wei: bigint) => `${formatUnits(wei, 18)} USDC`;

const PRICE = 30_000n; // $0.03, a real mainnet price
const client = publicClient();
const buyer = privateKeyToAccount(generatePrivateKey());
const payTo: Address = privateKeyToAccount(generatePrivateKey()).address; // stands in for a vault: any address

// The buyer holds exactly the price and nothing for gas.
await confirm(
  await walletClient().sendTransaction({ account: operator(), chain: arcChain(), to: buyer.address, value: unitsToWei(PRICE), ...(await feeOverrides()) }),
);
check("the buyer holds exactly the price and no gas", (await client.getBalance({ address: buyer.address })) === unitsToWei(PRICE));

const requirements = buildRequirements(payTo, PRICE);
const auth = buildAuthorization(buyer.address, payTo, PRICE);
const signature: Hex = await signAuthorization(buyer, auth);
const resource = { url: "https://cgs.local/direct-settle-check", description: "direct settlement check", mimeType: "application/json" };
const input = { requirements, resource, authorization: auth, signature, paymentId: `direct-${randomBytes(8).toString("hex")}` };

console.log("\n== Circle refuses us, and the purchase settles anyway ==");
const operatorBefore = await client.getBalance({ address: operator().address });
const outcome = await settlePayment(input);
check("the payment settled", outcome.status === "settled", JSON.stringify(outcome));
if (outcome.status !== "settled") process.exit(1);
check("the payer is the buyer", outcome.payer.toLowerCase() === buyer.address.toLowerCase());
check("the amount is the price", outcome.amount === PRICE.toString(), outcome.amount);

const receipt = await client.getTransactionReceipt({ hash: outcome.transaction });
check("the transaction succeeded on chain", receipt.status === "success");
check("it was sent by the operator, who paid the gas", receipt.from.toLowerCase() === operator().address.toLowerCase(), receipt.from);
check("the money reached the recipient, the exact price", (await client.getBalance({ address: payTo })) === unitsToWei(PRICE), fmt(await client.getBalance({ address: payTo })));
check("the buyer paid the price and nothing else", (await getUsdcUnits(buyer.address)) === 0n);
check("the operator spent only gas", (await client.getBalance({ address: operator().address })) < operatorBefore);
check("the authorization is spent", await isAuthorizationUsed(buyer.address, auth.nonce));

console.log("\n== the same payment cannot be settled twice ==");
const again = await settlePayment({ ...input, paymentId: `direct-${randomBytes(8).toString("hex")}` });
check("a replay is refused", again.status === "failed", JSON.stringify(again));
check("and moves nothing", (await client.getBalance({ address: payTo })) === unitsToWei(PRICE));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
