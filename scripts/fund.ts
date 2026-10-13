/**
 * Send testnet USDC from the operator to any address.
 *
 *   npm run fund -- 0xAddress [amountUsdc]      # default 2
 *   npm run fund                                # just prints the operator's balance
 *
 * Exists because a deployed server runs NODE_ENV=production with the dev
 * faucet off (the env schema refuses to boot otherwise), so a test wallet on a
 * deployed testnet instance has no other way to get USDC than Circle's faucet.
 * This runs from your machine with the operator key, not as a public route.
 * Testnet only: refuses to run against mainnet.
 */
import { formatUnits, isAddress, type Address } from "viem";
import { env } from "../src/config/env.js";
import { arcChain, confirm, feeOverrides, operator, unitsToWei, walletClient } from "../src/services/arc/client.js";
import { getUsdcUnits } from "../src/services/arc/reads.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("fund only runs against testnet");

const [to, amountArg] = process.argv.slice(2);
const fmt = (u: bigint) => `${formatUnits(u, 6)} USDC`;
console.log(`operator ${operator().address}: ${fmt(await getUsdcUnits(operator().address))}`);

if (to) {
  if (!isAddress(to)) throw new Error(`not an address: ${to}`);
  const amount = Number(amountArg ?? "2");
  if (!(amount > 0 && amount <= 50)) throw new Error("amount must be between 0 and 50 USDC");
  const units = BigInt(Math.round(amount * 1_000_000));
  await confirm(
    await walletClient().sendTransaction({
      account: operator(), chain: arcChain(), to: to as Address, value: unitsToWei(units), ...(await feeOverrides()),
    }),
  );
  console.log(`sent ${fmt(units)} to ${to}; it now holds ${fmt(await getUsdcUnits(to as Address))}`);
}
process.exit(0);
