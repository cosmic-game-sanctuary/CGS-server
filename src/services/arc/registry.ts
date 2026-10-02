import { pad, type Address, type Hex } from "viem";
import { gameRegistryAbi } from "./abis.js";
import { confirm, feeOverrides, operator, publicClient, registryAddress, walletClient, withGasHeadroom } from "./client.js";

// A game's on-chain id is its database uuid, left-padded to 32 bytes. Not a
// hash: the id on an event and the row it came from stay visibly the same.
export function gameIdFor(gameUuid: string): Hex {
  const hex = gameUuid.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`not a uuid: ${gameUuid}`);
  return pad(`0x${hex}`, { size: 32 });
}

export function uuidFromGameId(gameId: Hex): string | null {
  if (!/^0x0{32}[0-9a-fA-F]{32}$/.test(gameId)) return null;
  const h = gameId.slice(34);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toLowerCase();
}

type RegistryWrite =
  | { fn: "publish"; args: readonly [Hex, string, bigint, Address, string] }
  | { fn: "setPrice"; args: readonly [Hex, bigint, bigint, bigint] }
  | { fn: "updateBuild"; args: readonly [Hex, number, string] }
  | { fn: "delist"; args: readonly [Hex] }
  | { fn: "relist"; args: readonly [Hex, bigint] };

// Simulated first so a rejected call (wrong operator, already published) fails
// with the contract's own error name instead of a bare revert after gas.
async function write(call: RegistryWrite) {
  const { request } = await publicClient().simulateContract({
    account: operator(),
    address: registryAddress(),
    abi: gameRegistryAbi,
    functionName: call.fn,
    args: call.args as never,
    ...(await feeOverrides()),
  } as never);
  const txHash = await walletClient().writeContract((await withGasHeadroom(request)) as never);
  const receipt = await confirm(txHash);
  return { txHash, blockNumber: receipt.blockNumber };
}

export type PublishInput = {
  gameId: Hex;
  slug: string;
  priceUnits: bigint;
  vault: Address;
  buildCid: string;
};

export const publishListing = (i: PublishInput) =>
  write({ fn: "publish", args: [i.gameId, i.slug, i.priceUnits, i.vault, i.buildCid] });

// endsAt is unix seconds, or 0n when the change is not a timed sale.
export const announcePrice = (gameId: Hex, fromUnits: bigint, toUnits: bigint, endsAt: bigint = 0n) =>
  write({ fn: "setPrice", args: [gameId, fromUnits, toUnits, endsAt] });

export const announceBuild = (gameId: Hex, version: number, buildCid: string) =>
  write({ fn: "updateBuild", args: [gameId, version, buildCid] });

export const delistListing = (gameId: Hex) => write({ fn: "delist", args: [gameId] });

export const relistListing = (gameId: Hex, priceUnits: bigint) =>
  write({ fn: "relist", args: [gameId, priceUnits] });

const ZERO: Address = "0x0000000000000000000000000000000000000000";

export async function getListing(gameId: Hex): Promise<{ published: boolean; vault: Address | null; delisted: boolean }> {
  const [vault, delisted] = await publicClient().multicall({
    allowFailure: false,
    contracts: [
      { address: registryAddress(), abi: gameRegistryAbi, functionName: "vaultOf", args: [gameId] },
      { address: registryAddress(), abi: gameRegistryAbi, functionName: "delisted", args: [gameId] },
    ],
  });
  return { published: vault !== ZERO, vault: vault === ZERO ? null : vault, delisted };
}
