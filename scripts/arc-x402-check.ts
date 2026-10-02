/**
 * Proves the Stage 4 payment path against the real Circle Facilitator Service
 * and the real Arc testnet. Exits non-zero if anything is off.
 *
 *   npx tsx scripts/arc-x402-check.ts
 *
 * What it settles for real:
 *   - a buyer holding *only* the purchase price and no gas at all pays, and
 *     still pays nothing — Circle covers settlement gas
 *   - the money lands where the terms said it would
 *   - the same authorization cannot be settled twice
 *
 * Which destination it uses depends on how it is authenticated:
 *   CIRCLE_API_KEY set  -> payTo is a real SplitVault contract (production shape)
 *   not set             -> payTo is the operator EOA, because Circle's keyless
 *                          trial authenticates with a signature from the key
 *                          controlling payTo and a vault has no key.
 * Each settle consumes one keyless-trial allowance for its payTo, so don't loop
 * this needlessly on the trial.
 */
import { randomUUID } from "node:crypto";
import { formatUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config/env.js";
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
import { erc20Abi } from "../src/services/arc/abis.js";
import { getVaultState } from "../src/services/arc/vault.js";
import {
  assertDomainMatchesChain,
  buildAuthorization,
  checkAuthorizationLocally,
  isAuthorizationUsed,
  recoverPayer,
} from "../src/services/arc/x402/authorization.js";
import { buildRequirements, requirementsMatch } from "../src/services/arc/x402/requirements.js";
import { settlePayment, awaitSettlement } from "../src/services/arc/x402/facilitator.js";
import { encodePaymentHeader, signAuthorization } from "../src/services/arc/x402/payer.js";
import { decodePaymentHeader, payToFor } from "../src/services/arc/x402/gate.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("arc-x402-check only runs against testnet");

const VAULT = (process.env.ARC_CHECK_VAULT as Address) ?? "0x71349A7527A6Cb3d1bEa1153f2a5c7C8fC36C5b4";
const PRICE_UNITS = 250_000n; // 0.25 USDC — a real price, kept small on purpose.

const client = publicClient();
const me = operator().address;
const usingApiKey = Boolean(env.CIRCLE_API_KEY);
const payTo: Address = usingApiKey ? VAULT : me;

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};
const fmt = (w: bigint) => `${formatUnits(w, 18)} USDC`;
const units = (a: Address) => client.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [a] });

console.log(`\nauthenticating with ${usingApiKey ? "a Circle API key" : "Circle's KEYLESS TRIAL"}`);
console.log(`payTo: ${payTo}${usingApiKey ? " (SplitVault contract — the production shape)" : " (operator EOA — the trial cannot settle to a keyless contract)"}\n`);

console.log("== signing domain ==");
await assertDomainMatchesChain();
check("USDC's on-chain DOMAIN_SEPARATOR matches the domain we sign with", true);

console.log("\n== terms ==");
const requirements = buildRequirements(payTo, PRICE_UNITS);
check("network is Arc's CAIP-2 id", requirements.network === `eip155:${arcChain().id}`, requirements.network);
check("asset is Arc's native USDC", requirements.asset === USDC_ADDRESS);
check("amount is atomic 6dp units", requirements.amount === "250000", requirements.amount);
check("scheme and transfer method are the EIP-3009 exact scheme", requirements.scheme === "exact" && requirements.extra.assetTransferMethod === "eip3009");
check("our own terms match themselves", requirementsMatch(requirements, requirements));
check("tampered payTo is rejected", !requirementsMatch(requirements, { ...requirements, payTo: me === payTo ? VAULT : me }));
check("tampered amount is rejected", !requirementsMatch(requirements, { ...requirements, amount: "1" }));
check(
  "a game with a vault pays into that vault, not the fallback",
  payToFor({ id: "g", title: "t", vaultAddress: VAULT }) === VAULT,
);

console.log("\n== a buyer with the price and nothing else ==");
const buyer = privateKeyToAccount(generatePrivateKey());
const priceWei = unitsToWei(PRICE_UNITS);
await confirm(
  await walletClient().sendTransaction({ account: operator(), chain: arcChain(), to: buyer.address, value: priceWei, ...(await feeOverrides()) }),
);
const buyerStart = await units(buyer.address);
check("buyer holds exactly the price", buyerStart === PRICE_UNITS, `${buyerStart} vs ${PRICE_UNITS}`);
check("buyer could not pay gas even if asked to", (await client.getBalance({ address: buyer.address })) === priceWei);

const auth = buildAuthorization(buyer.address, payTo, PRICE_UNITS);
const signature = await signAuthorization(buyer, auth);
check("the signature recovers to the buyer", (await recoverPayer(auth, signature)).toLowerCase() === buyer.address.toLowerCase());
check("nonce is unused before settling", !(await isAuthorizationUsed(buyer.address, auth.nonce)));

console.log("\n== local pre-checks (so a bad payment names its own reason) ==");
const good = await checkAuthorizationLocally(auth, signature, { to: payTo, units: PRICE_UNITS });
check("a correct authorization passes", good.ok, good.ok ? "" : good.reason);
const wrongTo = await checkAuthorizationLocally({ ...auth, to: me === payTo ? VAULT : me }, signature, { to: payTo, units: PRICE_UNITS });
check("a payment to the wrong address is caught", !wrongTo.ok && wrongTo.reason === "invalid_exact_evm_payload_recipient_mismatch");
const wrongValue = await checkAuthorizationLocally({ ...auth, value: 1n }, signature, { to: payTo, units: PRICE_UNITS });
check("a payment for the wrong amount is caught", !wrongValue.ok && wrongValue.reason === "invalid_exact_evm_payload_authorization_value_mismatch");
const expired = await checkAuthorizationLocally({ ...auth, validBefore: 1n }, signature, { to: payTo, units: PRICE_UNITS });
check("an expired authorization is caught", !expired.ok && expired.reason === "invalid_exact_evm_payload_authorization_valid_before");
const poor = privateKeyToAccount(generatePrivateKey());
const poorAuth = buildAuthorization(poor.address, payTo, PRICE_UNITS);
const poorCheck = await checkAuthorizationLocally(poorAuth, await signAuthorization(poor, poorAuth), { to: payTo, units: PRICE_UNITS });
check("an empty wallet is caught before Circle is troubled", !poorCheck.ok && poorCheck.reason === "insufficient_funds");

console.log("\n== the header a client actually sends ==");
const resource = { url: "https://cgs.test/api/games/check/download", description: "Stage 4 check", mimeType: "application/json" };
const header = encodePaymentHeader({ requirements, resource, authorization: auth, signature });
const decoded = decodePaymentHeader(header);
check("header round-trips the authorization exactly", decoded.authorization.nonce === auth.nonce && decoded.authorization.value === auth.value && decoded.authorization.to.toLowerCase() === auth.to.toLowerCase());
check("header round-trips the signature", decoded.signature === signature);
check("decoded terms still match ours", requirementsMatch(requirements, decoded.accepted));

console.log("\n== settling through Circle (real money, real network) ==");
const payeeStart = payTo === me ? buyerStart * 0n + (await units(me)) : (await getVaultState(VAULT)).totalReceivedWei;
const paymentId = `cgs_check_${randomUUID().replaceAll("-", "")}`.slice(0, 64);
const t0 = Date.now();
let outcome = await settlePayment({ requirements, resource, authorization: auth, signature, paymentId });
outcome = await awaitSettlement(outcome, payTo);
console.log(`   settle returned "${outcome.status}" in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (outcome.status === "failed") {
  console.log(`   reason: ${outcome.reason}\n   message: ${outcome.message}`);
  check("Circle settled the payment", false, outcome.reason);
} else if (outcome.status === "pending") {
  check("Circle settled the payment", false, "still pending after the poll window");
} else {
  check("Circle settled the payment", true);
  console.log(`   transaction: ${outcome.transaction}`);
  const receipt = await client.getTransactionReceipt({ hash: outcome.transaction as Hex });
  check("the settlement transaction succeeded on chain", receipt.status === "success");
  check("Circle paid the settlement gas, not us and not the buyer", receipt.from.toLowerCase() !== me.toLowerCase() && receipt.from.toLowerCase() !== buyer.address.toLowerCase(), receipt.from);
  console.log(`   gas Circle paid: ${fmt(receipt.gasUsed * receipt.effectiveGasPrice)} (from ${receipt.from})`);
  check("Circle reported the buyer as payer", outcome.payer.toLowerCase() === buyer.address.toLowerCase());

  check("the buyer's balance went to zero — they paid the price and no gas", (await units(buyer.address)) === 0n);
  if (payTo === me) {
    check("the money arrived at the payout address", (await units(me)) >= payeeStart + PRICE_UNITS - 1n);
  } else {
    const after = await getVaultState(VAULT);
    check("the money arrived in the vault", after.totalReceivedWei - payeeStart === priceWei, `${after.totalReceivedWei - payeeStart} vs ${priceWei}`);
    const platform = after.payees.find((p) => p.bps === env.PLATFORM_FEE_BPS);
    const studio = after.payees.find((p) => p.bps === 10_000 - env.PLATFORM_FEE_BPS);
    check("the vault split it without us touching it", Boolean(platform && studio));
    if (platform && studio) {
      console.log(`   platform ${platform.bps} bps -> claimable ${fmt(platform.claimableWei)}`);
      console.log(`   studio   ${studio.bps} bps -> claimable ${fmt(studio.claimableWei)}`);
    }
  }

  check("the authorization is now spent on chain", await isAuthorizationUsed(buyer.address, auth.nonce));

  console.log("\n== the same authorization cannot pay twice ==");
  const replay = await checkAuthorizationLocally(auth, signature, { to: payTo, units: PRICE_UNITS });
  check("a replay is refused locally", !replay.ok && replay.reason === "invalid_transaction_state", replay.ok ? "accepted!" : "");
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
