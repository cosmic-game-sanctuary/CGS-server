import { games } from "../../db/schema.js";
import { Errors } from "../../lib/errors.js";
import { getAccountByEvmAddress } from "../hedera/mirror.js";
import { hasEntitlement } from "./entitlement.js";
import { fulfilPurchase } from "./fulfil.js";
import type { Auth } from "../../middleware/auth.middleware.js";

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
  const base = { buildPath: buildPathFor(game), buildCid: game.buildCid!, tokenId: game.htsTokenId };

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
 * Nothing to do if the wallet has never received value: there is no Hedera
 * account to mint to yet. That is not an error, it just means the key arrives
 * the first time they come back with a funded wallet.
 */
async function grantFreeKey(game: Game, buyerEvmAddress: string): Promise<void> {
  const { owned } = await hasEntitlement(buyerEvmAddress, game);
  if (owned) return;

  const account = await getAccountByEvmAddress(buyerEvmAddress);
  if (!account) return;

  void fulfilPurchase(game, account.account, "free");
}
