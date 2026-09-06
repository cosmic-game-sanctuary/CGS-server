import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { games, gameKeys } from "../../db/schema.js";
import { ownsGame } from "./ownership.js";
import { getAccountByEvmAddress } from "../hedera/mirror.js";

type Game = typeof games.$inferSelect;

export type Entitlement = {
  owned: boolean;
  serial?: number;
  /**
   * Where the answer came from.
   *   chain  — the wallet holds the GameKey. The only proof that outlives us.
   *   record — they paid, and the key hasn't landed in the wallet yet.
   */
  source: "chain" | "record" | "none";
};

/**
 * "Is this person allowed to play this game", which is a wider question than
 * `ownsGame` answers.
 *
 * `ownsGame` asks the Mirror Node whether the wallet holds the NFT, and that is
 * the right question for anything that has to be provable to someone else. It
 * is the wrong question in the seconds after a purchase: payment settles first,
 * the mint follows, and in that gap the buyer has paid real money and holds no
 * key. Gating play on the chain alone locks them out of the one moment the
 * whole product is about.
 *
 * So a `game_keys` row counts too. One is written the instant fulfilment starts
 * (see fulfil.ts), before the mint is attempted, and its status records how far
 * the mint got. A `failed` row still counts — the payment succeeded, the mint
 * is ours to retry, and that is not the buyer's problem.
 *
 * Reviews deliberately keep using `ownsGame`: a verified-purchase badge is a
 * claim made to other people, so it should rest on what other people can check.
 */
export async function hasEntitlement(evmAddress: string, game: Game): Promise<Entitlement> {
  const onChain = await ownsGame(evmAddress, game.htsTokenId);
  if (onChain.owned) return { owned: true, serial: onChain.serial, source: "chain" };

  const account = await getAccountByEvmAddress(evmAddress);
  if (!account) return { owned: false, source: "none" };

  const key = await db.query.gameKeys.findFirst({
    where: and(eq(gameKeys.gameId, game.id), eq(gameKeys.ownerAccountId, account.account)),
  });
  if (!key) return { owned: false, source: "none" };

  return { owned: true, serial: key.serial ?? undefined, source: "record" };
}
