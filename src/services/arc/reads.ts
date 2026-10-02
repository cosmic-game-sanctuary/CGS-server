import type { Address, Hex } from "viem";
import { erc20Abi, gameRegistryAbi } from "./abis.js";
import { publicClient, registryAddress, USDC_ADDRESS } from "./client.js";

// eth_blockNumber can trail what a `latest` state read already sees by a block or
// more (measured on Arc testnet), so never pin a state read to it. For a log
// cursor that lag is the safe direction: it only ever delays an event.
export const getBlockNumber = () => publicClient().getBlockNumber();

// USDC through its ERC-20 face: 6 decimals, the app's own unit.
export const getUsdcUnits = (address: Address) =>
  publicClient().readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] });

// The same balance in native 18-decimal wei — what pays gas.
export const getNativeWei = (address: Address) => publicClient().getBalance({ address });

export async function getTxStatus(hash: Hex): Promise<"success" | "reverted" | "not_found"> {
  try {
    const receipt = await publicClient().getTransactionReceipt({ hash });
    return receipt.status;
  } catch (err) {
    if (err instanceof Error && err.name === "TransactionReceiptNotFoundError") return "not_found";
    throw err;
  }
}

// Arc's public RPC rejects any getLogs span of 10,000 blocks or more
// ("requested range too large"). At ~0.5s a block that is about 80 minutes, so
// anything reading history in bulk has to walk it in windows.
const MAX_LOG_SPAN = 9_000n;

export type ListingEvent = { blockNumber: bigint; logIndex: number; txHash: Hex } & (
  | { kind: "listed"; gameId: Hex; slug: string; priceUnits: bigint; vault: Address; buildCid: string }
  | { kind: "price_changed"; gameId: Hex; fromUnits: bigint; toUnits: bigint; endsAt: bigint }
  | { kind: "build_updated"; gameId: Hex; version: number; buildCid: string }
  | { kind: "delisted"; gameId: Hex }
  | { kind: "relisted"; gameId: Hex; priceUnits: bigint }
  // Not price-bearing. A reader deciding whether to buy must not treat this as
  // an offer — it says how many people want the game, not what it costs.
  | { kind: "demand"; gameId: Hex; wishlistCount: number; milestone: number }
);

const looksLikeRangeLimit = (err: unknown) =>
  /range|too large|limit|exceed|10000/i.test(err instanceof Error ? `${err.name} ${err.message}` : String(err));

async function listingWindow(fromBlock: bigint, toBlock: bigint): Promise<ListingEvent[]> {
  let logs;
  try {
    logs = await publicClient().getContractEvents({
      address: registryAddress(),
      abi: gameRegistryAbi,
      fromBlock,
      toBlock,
      strict: true,
    });
  } catch (err) {
    // A different provider may cap the span lower than Arc's own. Halve and
    // retry rather than hard-code one provider's number.
    if (toBlock > fromBlock && looksLikeRangeLimit(err)) {
      const mid = fromBlock + (toBlock - fromBlock) / 2n;
      return [...(await listingWindow(fromBlock, mid)), ...(await listingWindow(mid + 1n, toBlock))];
    }
    throw err;
  }

  return logs.map((l): ListingEvent => {
    const at = { blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash };
    switch (l.eventName) {
      case "Listed":
        return { ...at, kind: "listed", ...l.args };
      case "PriceChanged":
        return { ...at, kind: "price_changed", ...l.args };
      case "BuildUpdated":
        return { ...at, kind: "build_updated", ...l.args };
      case "Delisted":
        return { ...at, kind: "delisted", ...l.args };
      case "Relisted":
        return { ...at, kind: "relisted", ...l.args };
      case "Demand":
        return { ...at, kind: "demand", ...l.args };
    }
  });
}

// Every registry event in [fromBlock, toBlock], oldest first, however wide the
// range. The agent's cursor is a block number: it resumes from the last block
// it processed and asks for everything after.
export async function getListingEvents(fromBlock: bigint, toBlock?: bigint): Promise<ListingEvent[]> {
  const end = toBlock ?? (await getBlockNumber());
  const out: ListingEvent[] = [];
  for (let from = fromBlock; from <= end; from += MAX_LOG_SPAN) {
    const to = from + MAX_LOG_SPAN - 1n > end ? end : from + MAX_LOG_SPAN - 1n;
    out.push(...(await listingWindow(from, to)));
  }
  return out.sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
}
