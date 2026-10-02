import { parseEventLogs, type Address, type Hex } from "viem";
import { gameKeyAbi } from "./abis.js";
import { confirm, feeOverrides, keyAddress, operator, publicClient, walletClient, withGasHeadroom } from "./client.js";

export async function mintKey(to: Address, gameId: Hex): Promise<{ tokenId: bigint; txHash: Hex }> {
  const { request } = await publicClient().simulateContract({
    account: operator(),
    address: keyAddress(),
    abi: gameKeyAbi,
    functionName: "mint",
    args: [to, gameId],
    ...(await feeOverrides()),
  });
  const txHash = await walletClient().writeContract(await withGasHeadroom(request));
  const receipt = await confirm(txHash);

  const transfer = parseEventLogs({ abi: gameKeyAbi, logs: receipt.logs, eventName: "Transfer" }).find(
    (l) => l.address.toLowerCase() === keyAddress().toLowerCase() && l.args.to.toLowerCase() === to.toLowerCase(),
  );
  if (!transfer) throw new Error(`mint ${txHash} succeeded but emitted no Transfer to ${to}`);
  return { tokenId: transfer.args.tokenId, txHash };
}

export type HeldKey = { tokenId: bigint; gameId: Hex };

// Contract state, not a log scan: Arc's public RPC refuses getLogs over ~10,000
// blocks, so "what does this wallet hold" has to come from storage. GameKey
// answers it in a single eth_call, which is also one consistent snapshot.
export async function keysHeldBy(holder: Address): Promise<HeldKey[]> {
  const [tokenIds, gameIds] = await publicClient().readContract({
    address: keyAddress(),
    abi: gameKeyAbi,
    functionName: "keysOf",
    args: [holder],
  });
  return tokenIds.map((tokenId, i) => ({ tokenId, gameId: gameIds[i]! }));
}

export type Ownership = { owned: false } | { owned: true; tokenId: bigint };

export async function ownsGame(holder: Address, gameId: Hex): Promise<Ownership> {
  const tokenId = await publicClient().readContract({
    address: keyAddress(),
    abi: gameKeyAbi,
    functionName: "keyFor",
    args: [holder, gameId],
  });
  return tokenId === 0n ? { owned: false } : { owned: true, tokenId };
}
