import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { env } from "../../config/env.js";

// the operator account for every ENS transaction the backend makes — a
// dedicated key, generated fresh, never a personal wallet. Same role
// SEPOLIA_OPERATOR_KEY plays here as HEDERA_OPERATOR_KEY plays on the Hedera
// side.
export const ensAccount = privateKeyToAccount(env.SEPOLIA_OPERATOR_KEY as `0x${string}`);

export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(env.SEPOLIA_RPC_URL),
});

export const walletClient = createWalletClient({
  account: ensAccount,
  chain: sepolia,
  transport: http(env.SEPOLIA_RPC_URL),
});
