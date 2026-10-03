import type { Address } from "viem";
import { games } from "../../db/schema.js";
import { Errors } from "../../lib/errors.js";
import { hasEntitlement } from "./entitlement.js";
import { fulfilArcPurchase } from "./fulfilArc.js";
import type { Auth } from "../../middleware/auth.middleware.js";
import { keyAddress } from "../arc/client.js";
import logger from "../../utils/logger.utils.js";

type Game = typeof games.$inferSelect;

/** What a caller gets once they're entitled to the build. */
export type AccessGrant = {
  /**
   * Where to fetch the build zip from, relative to the API. The client unpacks
   * it and runs it on its own isolated origin — see buildStore.ts for why this
   * isn't an IPFS gateway URL.
   */
  buildPath: string;
  /** What the build is, on IPFS. Provenance, not delivery. */
  buildCid: string;
  tokenId: string | null;
  serial?: number;
  keyStatus: "free" | "owned" | "pending";
  settlementTxId?: string;
};

export function buildPathFor(game: Game): string {
  return `/api/games/${game.id}/build.zip`;
}

/** Every reason a game might not be servable at all, in one place. */
export function assertServable(game: Game): void {
  // Delisting removes a game from the catalog. It does not revoke anyone's
  // copy. Only `removed` — illegal content, unpinned from storage — ends access.
  if (game.status === "removed") throw Errors.notFound("Game");
  if (game.status === "draft") throw Errors.gameNotPublished();
  if (!game.buildCid) throw Errors.gameNotPublished("This game has no build pinned.");
}

/**
 * The two ways to reach a build without paying for it right now: it's free, or
 * you already bought it. Returns null when neither applies, which means the
 * caller has to pay.
 *
 * Lives here rather than inside the download route because the payment path
 * needs the same answer before it starts building a transaction. Asking twice
 * in two slightly different ways is how a free game ends up minting no key on
 * one path and a key on the other, which is exactly what happened.
 */
export async function grantAccess(game: Game, auth: Auth | undefined): Promise<AccessGrant | null> {
  assertServable(game);
  // `tokenId` is the GameKey *contract*, not a per-game token. On Hedera every
  // game minted its own HTS token, so `games.hts_token_id` identified the key
  // you were about to receive; on Arc one ERC-721 collection covers every game
  // and the key is identified by that address plus a token id the mint assigns.
  // So this names the collection, and the serial arrives with the key.
  const base = { buildPath: buildPathFor(game), buildCid: game.buildCid!, tokenId: keyAddress() };

  // A free game is still a purchase — it mints a real GameKey to a real
  // wallet — so it needs to know who you are. Browsing doesn't require an
  // account; getting a game does, at any price.
  if (!auth) return null;

  if (game.priceUnits === 0) {
    await grantFreeKey(game, auth.evmAddress);
    return { ...base, keyStatus: "free" };
  }

  const { owned, serial } = await hasEntitlement(auth.evmAddress, game);
  if (!owned) return null;

  return { ...base, serial, keyStatus: "owned" };
}

/**
 * A free game still mints a real GameKey. `price = 0` is a real purchase with
 * real ownership, not a bypass.
 *
 * Simpler on Arc than it was on Hedera, where a wallet that had never received
 * value had no account to mint to and the key had to wait for one. An address is
 * a valid recipient from the moment it exists, so a free game's key mints the
 * first time someone asks for it, funded or not.
 */
async function grantFreeKey(game: Game, buyerEvmAddress: string): Promise<void> {
  const { owned } = await hasEntitlement(buyerEvmAddress, game);
  if (owned) return;

  // Nothing was received, so there is nothing to split and no vault involved.
  //
  // The `.catch` is not decoration. `fulfilArcPurchase` awaits two database
  // inserts before it reaches the mint it already guards, so it can reject —
  // and an unhandled rejection **terminates a Node process**, which on this
  // path meant a database hiccup while someone claimed a free game could take
  // the whole server down and, with it, every in-memory payment intent of
  // everyone mid-purchase at that moment. Deliberately fire-and-forget, so the
  // failure belongs in the log rather than in this request's response.
  void fulfilArcPurchase({
    game,
    ownerAddress: buyerEvmAddress as Address,
    payerAddress: buyerEvmAddress as Address,
    settlementTx: "0x",
    amountUnits: 0,
    kind: "purchase",
  }).catch((err) => logger.error({ err, gameId: game.id, buyerEvmAddress }, "granting a free game's key failed"));
}
