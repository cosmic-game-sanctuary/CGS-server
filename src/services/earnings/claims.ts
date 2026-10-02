import { inArray } from "drizzle-orm";
import { getAddress, type Address } from "viem";
import { db } from "../../db/client.js";
import { games } from "../../db/schema.js";
import { weiToUnits } from "../arc/client.js";
import { claimFor, getVaultState } from "../arc/vault.js";
import { assetDecimals, toDisplayAmount } from "../../lib/display.js";
import logger from "../../utils/logger.utils.js";

/**
 * What a payee can take out, read from the contract that holds it.
 *
 * This replaces the held/failed payout reporting the Hedera build needed. There
 * used to be three states a share could be in — paid, held because the person
 * had no account yet, or failed — and all three existed because *we* were the
 * one moving the money. On Arc the money never passes through us: a sale credits
 * the game's vault directly and the vault divides it, so a share is either still
 * in the vault or already withdrawn. Nothing can be stuck, and there is no
 * state where we owe someone something we failed to send.
 *
 * Everything here reads the chain rather than our own tables, and that is the
 * point rather than an implementation detail: these are the numbers a payee can
 * verify on the explorer without trusting us, and they cannot drift from what
 * the contract will actually pay because they *are* what the contract says.
 */

function money(units: number, asset: string) {
  return { units, display: toDisplayAmount(units, asset), assetDecimals: assetDecimals(asset) };
}

export type GameClaim = {
  gameId: string;
  gameTitle: string;
  gameSlug: string;
  vault: Address;
  /** This payee's share of the vault, in basis points of the whole sale. */
  bps: number;
  /** Everything ever owed to them from this game. */
  earned: ReturnType<typeof money>;
  /** What they have already taken out. */
  claimed: ReturnType<typeof money>;
  /** What is sitting in the vault with their name on it right now. */
  claimable: ReturnType<typeof money>;
};

/**
 * Every game in `gameIds` that pays `address`, with the amounts from its vault.
 *
 * Games with no vault are skipped rather than reported as zero: a game with no
 * vault was never published, so it has no sales and nothing to claim, and
 * listing it would put a row of zeroes in front of the payee for every draft
 * they are credited on.
 *
 * A vault that cannot be read is skipped with a log rather than failing the
 * whole report — one unreachable contract should not blank out a dashboard that
 * is mostly about games that are fine.
 */
export async function claimsFor(address: string, gameIds: string[]): Promise<GameClaim[]> {
  if (gameIds.length === 0) return [];
  const me = getAddress(address);

  const rows = await db.query.games.findMany({
    where: inArray(games.id, gameIds),
    columns: { id: true, title: true, slug: true, vaultAddress: true, priceAsset: true },
  });

  const out: GameClaim[] = [];
  await Promise.all(
    rows.map(async (game) => {
      if (!game.vaultAddress) return;
      try {
        const state = await getVaultState(game.vaultAddress as Address);
        const mine = state.payees.find((p) => getAddress(p.address) === me);
        if (!mine) return;

        out.push({
          gameId: game.id,
          gameTitle: game.title,
          gameSlug: game.slug,
          vault: state.vault,
          bps: mine.bps,
          earned: money(Number(weiToUnits(mine.owedWei)), game.priceAsset),
          claimed: money(Number(weiToUnits(mine.claimedWei)), game.priceAsset),
          claimable: money(Number(weiToUnits(mine.claimableWei)), game.priceAsset),
        });
      } catch (err) {
        logger.error({ err, gameId: game.id, vault: game.vaultAddress }, "could not read a game's vault for earnings");
      }
    }),
  );

  return out.sort((a, b) => b.claimable.units - a.claimable.units);
}

export class NothingToClaim extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NothingToClaim";
  }
}

/**
 * Take a payee's share out of one game's vault, with the platform paying the gas.
 *
 * The gas matters more than it sounds. Gas on Arc is USDC, so a developer whose
 * first earnings are still in the vault cannot afford the transaction that
 * releases them — their money is one transaction away and they cannot pay for
 * it. `SplitVault.claimFor` lets anyone pay instead, and sends only to the
 * payee, so this costs us a fraction of a cent and gives us no say over the
 * money. A developer who would rather not involve us can call `claim()` from
 * their own wallet, or have anyone else call `claimFor`.
 */
export async function claimFromVault(address: string, gameId: string) {
  const game = await db.query.games.findFirst({
    where: inArray(games.id, [gameId]),
    columns: { id: true, title: true, vaultAddress: true, priceAsset: true },
  });
  if (!game) throw new NothingToClaim("No such game.");
  if (!game.vaultAddress) throw new NothingToClaim("That game has no vault yet, so it has nothing to pay out.");

  const me = getAddress(address);
  const state = await getVaultState(game.vaultAddress as Address);
  const mine = state.payees.find((p) => getAddress(p.address) === me);
  if (!mine) throw new NothingToClaim("You are not a payee on that game.");
  if (mine.claimableWei === 0n) throw new NothingToClaim("You have nothing to claim from that game right now.");

  const { txHash, amountWei } = await claimFor(state.vault, me);
  const units = Number(weiToUnits(amountWei));
  logger.info({ gameId, payee: me, units, txHash }, "claimed a payee's share from the vault");

  return {
    gameId: game.id,
    gameTitle: game.title,
    vault: state.vault,
    to: me,
    amount: money(units, game.priceAsset),
    txHash,
  };
}
