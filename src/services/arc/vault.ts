import type { Address, ContractFunctionParameters } from "viem";
import { splitVaultAbi } from "./abis.js";
import { publicClient, weiToUnits } from "./client.js";

export type VaultPayee = {
  address: Address;
  bps: number;
  // Native 18-decimal wei, exactly as the contract reports it.
  owedWei: bigint;
  claimedWei: bigint;
  claimableWei: bigint;
  // The same claimable amount in the app's 6-decimal price units, rounded down.
  claimableUnits: bigint;
};

export type VaultState = {
  vault: Address;
  totalReceivedWei: bigint;
  remainderPayee: Address;
  payees: VaultPayee[];
};

export async function getVaultState(vault: Address): Promise<VaultState> {
  const client = publicClient();
  const read = { address: vault, abi: splitVaultAbi } as const;

  // Payees and their shares are fixed at construction, so they can be read in
  // separate calls. Every figure that moves (what has arrived, what was
  // claimed) comes from the one multicall below, which is a single snapshot.
  const [count, remainderPayee] = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...read, functionName: "payeeCount" },
      { ...read, functionName: "remainderPayee" },
    ],
  });

  const addresses = await client.multicall({
    allowFailure: false,
    contracts: Array.from({ length: Number(count) }, (_, i) => ({
      ...read,
      functionName: "payees" as const,
      args: [BigInt(i)] as const,
    })),
  });

  const calls: ContractFunctionParameters<typeof splitVaultAbi>[] = [
    { ...read, functionName: "totalReceived" },
    ...addresses.flatMap((a): ContractFunctionParameters<typeof splitVaultAbi>[] => [
      { ...read, functionName: "bpsOf", args: [a] },
      { ...read, functionName: "owed", args: [a] },
      { ...read, functionName: "claimed", args: [a] },
      { ...read, functionName: "claimable", args: [a] },
    ]),
  ];
  const snapshot = (await client.multicall({ allowFailure: false, contracts: calls })) as unknown[];

  const totalReceivedWei = snapshot[0] as bigint;
  const payees = addresses.map((address, i): VaultPayee => {
    const [bps, owedWei, claimedWei, claimableWei] = snapshot.slice(1 + i * 4, 5 + i * 4) as unknown as [number, bigint, bigint, bigint];
    return { address, bps, owedWei, claimedWei, claimableWei, claimableUnits: weiToUnits(claimableWei) };
  });

  return { vault, totalReceivedWei, remainderPayee, payees };
}
