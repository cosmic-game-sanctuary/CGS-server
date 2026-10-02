/**
 * Proves the single assumption the whole Arc design rests on: that an EIP-3009
 * `transferWithAuthorization` to a **contract** address credits that contract's
 * native balance on Arc, so a `SplitVault` can be an x402 `payTo`.
 *
 *   npx tsx scripts/arc-eip3009-check.ts
 *
 * Deliberately does not involve Circle. Circle's only job is to submit this
 * transaction and pay its gas; what it submits is exactly the call made here.
 * Separating the two means a failure points at one of them rather than both,
 * and it means the contract half can be checked without consuming a Circle
 * trial allowance or needing an API key.
 *
 * Together with `arc-x402-check` (Circle really settles an authorization) and
 * `arc-purchase-check` (the server's whole purchase path), this covers the
 * production composition even when no API key is configured.
 */
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
import { getUsdcUnits } from "../src/services/arc/reads.js";
import { getVaultState } from "../src/services/arc/vault.js";
import {
  assertDomainMatchesChain,
  buildAuthorization,
  isAuthorizationUsed,
} from "../src/services/arc/x402/authorization.js";
import { signAuthorization } from "../src/services/arc/x402/payer.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("this only runs against testnet");

const VAULT = (process.env.ARC_CHECK_VAULT as Address) ?? "0x71349A7527A6Cb3d1bEa1153f2a5c7C8fC36C5b4";
const PRICE_UNITS = 200_000n; // 0.20 USDC

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};
const fmt = (w: bigint) => `${formatUnits(w, 18)} USDC`;

const client = publicClient();

console.log("\n== the signing domain is the one the token actually uses ==");
await assertDomainMatchesChain();
check("USDC's on-chain DOMAIN_SEPARATOR matches what we sign with", true);

console.log("\n== a buyer who cannot pay gas at all ==");
const buyer = privateKeyToAccount(generatePrivateKey());
const priceWei = unitsToWei(PRICE_UNITS);
await confirm(
  await walletClient().sendTransaction({
    account: operator(), chain: arcChain(), to: buyer.address, value: priceWei, ...(await feeOverrides()),
  }),
);
check("buyer holds exactly the price", (await getUsdcUnits(buyer.address)) === PRICE_UNITS);
check("and not one unit more, so it could not pay a fee", (await client.getBalance({ address: buyer.address })) === priceWei);

const auth = buildAuthorization(buyer.address, VAULT, PRICE_UNITS);
const signature = await signAuthorization(buyer, auth);
check("signing an authorization costs no gas and sends no transaction", (await client.getBalance({ address: buyer.address })) === priceWei);

console.log("\n== the vault before ==");
const before = await getVaultState(VAULT);
const beforeBalance = await client.getBalance({ address: VAULT });
console.log(`   balance ${fmt(beforeBalance)}, totalReceived ${fmt(before.totalReceivedWei)}`);

console.log("\n== submitting the authorization (Circle does this in production) ==");
const twaAbi = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const { request } = await client.simulateContract({
  account: operator(),
  address: USDC_ADDRESS,
  abi: twaAbi,
  functionName: "transferWithAuthorization",
  args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, signature],
  ...(await feeOverrides()),
});
const hash: Hex = await walletClient().writeContract(request);
const receipt = await confirm(hash);
console.log(`   ${hash}`);
console.log(`   gas the submitter paid: ${fmt(receipt.gasUsed * receipt.effectiveGasPrice)}`);

console.log("\n== the question the whole design rests on ==");
const afterBalance = await client.getBalance({ address: VAULT });
const after = await getVaultState(VAULT);
check(
  "an EIP-3009 transfer to a contract credits its native balance",
  afterBalance - beforeBalance === priceWei,
  fmt(afterBalance - beforeBalance),
);
check(
  "and SplitVault's own accounting sees it",
  after.totalReceivedWei - before.totalReceivedWei === priceWei,
  fmt(after.totalReceivedWei - before.totalReceivedWei),
);
check("the buyer paid the price and no gas", (await getUsdcUnits(buyer.address)) === 0n);
check("the authorization is spent, so it cannot be replayed", await isAuthorizationUsed(buyer.address, auth.nonce));

console.log("\n== the split, enforced by the contract and not by us ==");
const totalClaimable = after.payees.reduce((n, p) => n + p.claimableWei, 0n);
for (const p of after.payees) {
  const grew = p.claimableWei - (before.payees.find((b) => b.address === p.address)?.claimableWei ?? 0n);
  console.log(`   ${p.address} ${String(p.bps).padStart(5)} bps  +${fmt(grew)}  (claimable ${fmt(p.claimableWei)})`);
  check(
    `payee ${p.address.slice(0, 8)} got its exact share of this sale`,
    grew === (priceWei * BigInt(p.bps)) / 10_000n ||
      // The remainder payee absorbs integer-division dust, so it can be a hair over.
      (p.address === after.remainderPayee && grew >= (priceWei * BigInt(p.bps)) / 10_000n),
    fmt(grew),
  );
}
check("every unit received is claimable by someone", totalClaimable + after.payees.reduce((n, p) => n + p.claimedWei, 0n) === after.totalReceivedWei);
check("the platform's cut is the configured fee", after.payees.some((p) => p.bps === env.PLATFORM_FEE_BPS));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
