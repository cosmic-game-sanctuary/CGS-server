import type { Address } from "viem";
import { ownsGame as ownsOnChain } from "../arc/keys.js";
import { gameIdFor } from "../arc/registry.js";

/**
 * The only correct way to answer "does this wallet own this game" — asked of
 * Arc every time, never of the `game_keys` cache table.
 *
 * On Arc there is one `GameKey` collection for every game, and the key records
 * which game it is for, so this is a single `eth_call` against contract state
 * rather than the Hedera build's per-game token lookup. It is also the reason
 * `GameKey` is enumerable: the alternative is scanning `Transfer` logs, and
 * Arc's public RPC refuses a span wide enough to cover a game's history.
 *
 * Anyone can run this same query without our permission, which is what makes
 * ownership a claim about the chain rather than about our database.
 */
export async function ownsGame(
  evmAddress: string,
  /** The game's own id. Padded to the `bytes32` the contracts use. */
  gameUuid: string,
): Promise<{ owned: false } | { owned: true; serial: number }> {
  const result = await ownsOnChain(evmAddress as Address, gameIdFor(gameUuid));
  return result.owned ? { owned: true, serial: Number(result.tokenId) } : { owned: false };
}
