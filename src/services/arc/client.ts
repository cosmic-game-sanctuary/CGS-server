import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  nonceManager,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";
import { env } from "../../config/env.js";

// Arc silently drops any transaction whose max fee is under its base-fee
// floor: no error, no receipt, it simply never lands. viem's own estimate
// already clears it today; the clamp in feeOverrides() is what keeps that true
// if the node's suggestion ever dips.
export const MIN_FEE_PER_GAS = 20_000_000_000n;

// Native USDC accounting is 18 decimals, the ERC-20 face of the same balance is
// 6. The app's money is 6 (price_units); a vault's balance is native, so 18.
const WEI_PER_UNIT = 10n ** 12n;
export const weiToUnits = (wei: bigint): bigint => wei / WEI_PER_UNIT;
export const unitsToWei = (units: bigint): bigint => units * WEI_PER_UNIT;

export const USDC_ADDRESS: Address = "0x3600000000000000000000000000000000000000";
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const RECEIPT_TIMEOUT_MS = 60_000;

export class ArcConfigError extends Error {
  constructor(missing: string, why: string) {
    super(`${missing} is not set. ${why}`);
    this.name = "ArcConfigError";
  }
}

const baseChain = env.ARC_NETWORK === "mainnet" ? arc : arcTestnet;

// The public endpoints rate-limit (429, "rate limit exceeded") under a burst of
// concurrent writes, and any one of them can be down. Several independent
// providers are listed for testnet, so route across all of them.
const TESTNET_FALLBACK_RPC = "https://rpc.testnet.arc.io";

function rpcUrls(): string[] {
  const configured = env.ARC_RPC_URL?.split(",").map((u) => u.trim()).filter(Boolean);
  const urls = configured?.length
    ? configured
    : [...baseChain.rpcUrls.default.http, ...(env.ARC_NETWORK === "testnet" ? [TESTNET_FALLBACK_RPC] : [])];
  if (urls.length === 0) throw new ArcConfigError("ARC_RPC_URL", "viem ships no public RPC for Arc mainnet.");
  return urls;
}

function transport() {
  const urls = rpcUrls().map((url) => http(url, { retryCount: 4, retryDelay: 200, timeout: 15_000 }));
  return urls.length === 1 ? urls[0]! : fallback(urls, { retryCount: 1 });
}

let chain: ReturnType<typeof buildChain> | undefined;
function buildChain() {
  return defineChain({
    ...baseChain,
    rpcUrls: { default: { http: rpcUrls() } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
}
export function arcChain() {
  return (chain ??= buildChain());
}

let reader: PublicClient | undefined;
export function publicClient(): PublicClient {
  return (reader ??= createPublicClient({ chain: arcChain(), transport: transport() }) as PublicClient);
}

let operatorAccount: PrivateKeyAccount | undefined;
export function operator(): PrivateKeyAccount {
  if (!env.ARC_OPERATOR_KEY) {
    throw new ArcConfigError("ARC_OPERATOR_KEY", "It signs every on-chain write the backend makes.");
  }
  return (operatorAccount ??= privateKeyToAccount(env.ARC_OPERATOR_KEY as Hex, { nonceManager }));
}

let writer: WalletClient | undefined;
export function walletClient(): WalletClient {
  return (writer ??= createWalletClient({
    account: operator(),
    chain: arcChain(),
    transport: transport(),
  }));
}

export function registryAddress(): Address {
  if (!env.ARC_GAME_REGISTRY) throw new ArcConfigError("ARC_GAME_REGISTRY", "The deployed GameRegistry.");
  return env.ARC_GAME_REGISTRY as Address;
}

export function keyAddress(): Address {
  if (!env.ARC_GAME_KEY) throw new ArcConfigError("ARC_GAME_KEY", "The deployed GameKey.");
  return env.ARC_GAME_KEY as Address;
}

// eth_estimateGas sizes a transaction against the state as it is right now. A
// write that is estimated while its siblings are still in flight (three
// purchases landing together) can be sized too tight and run out of gas on
// chain. Seen on Arc testnet: a mint that used exactly its 177,119 limit. Unused
// gas is refunded, so headroom costs nothing.
const GAS_HEADROOM_PERCENT = 150n;
export async function withGasHeadroom<T extends object>(request: T): Promise<T & { gas: bigint }> {
  const estimate = await publicClient().estimateContractGas(request as never);
  return { ...request, gas: (estimate * GAS_HEADROOM_PERCENT) / 100n };
}

export async function feeOverrides() {
  const est = await publicClient().estimateFeesPerGas();
  const maxFeePerGas = est.maxFeePerGas! < MIN_FEE_PER_GAS ? MIN_FEE_PER_GAS : est.maxFeePerGas!;
  return { maxFeePerGas, maxPriorityFeePerGas: est.maxPriorityFeePerGas! };
}

// Waits for a write we already submitted. A timeout almost always means the
// fee was under the floor, so say so rather than surface a bare timeout.
export async function confirm(hash: Hex): Promise<TransactionReceipt> {
  let receipt: TransactionReceipt;
  try {
    receipt = await publicClient().waitForTransactionReceipt({
      hash,
      timeout: RECEIPT_TIMEOUT_MS,
      pollingInterval: 500,
    });
  } catch (err) {
    nonceManager.reset({ address: operator().address, chainId: arcChain().id });
    throw new Error(
      `Arc transaction ${hash} was not mined within ${RECEIPT_TIMEOUT_MS / 1000}s. ` +
        `Arc drops transactions under its ${MIN_FEE_PER_GAS / 1_000_000_000n} Gwei fee floor without any error. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (receipt.status !== "success") throw new Error(`Arc transaction ${hash} reverted on chain.`);
  return receipt;
}
