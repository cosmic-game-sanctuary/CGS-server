import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { games, sales } from "../../db/schema.js";

type Game = typeof games.$inferSelect;

/**
 * Paid trials: chunks of play, each a real x402 payment, that add up to
 * credit toward buying the game — see docs/stage-20.md.
 *
 * A trial chunk is recorded as an ordinary `sales` row (`kind: "trial_chunk"`)
 * rather than in a table of its own. That means it automatically gets every
 * mechanism a purchase already has — split distribution, the failed-split
 * retry script, the HCS sale announcement — for free, and it means credit is
 * **derived**, a live sum over real rows, rather than a stored counter that
 * could drift from what actually happened. This project already made that
 * call once, for `plays` and `likeCount`; money is a worse place to
 * discover drift than a play count.
 */

export function trialEnabled(game: Pick<Game, "trialChunkPriceUnits" | "trialMaxChunks">): boolean {
  return game.trialChunkPriceUnits !== null && game.trialMaxChunks !== null;
}

/** The worst case a trial can ever cost, in the same units as `priceUnits`. */
export function trialWorstCaseUnits(
  game: Pick<Game, "trialChunkPriceUnits" | "trialMaxChunks">,
): number {
  if (!trialEnabled(game)) return 0;
  return game.trialChunkPriceUnits! * game.trialMaxChunks!;
}

/**
 * A trial that could cost more than the game itself is absurd, so this is
 * enforced wherever the config is set (gameManage.routes.ts) rather than left
 * as a developer's mistake to discover later.
 */
export function trialConfigFits(
  priceUnits: number,
  chunkPriceUnits: number,
  maxChunks: number,
): boolean {
  return chunkPriceUnits > 0 && maxChunks > 0 && chunkPriceUnits * maxChunks <= priceUnits;
}

/** Every chunk this account has actually paid for on this game — the derived
 * ledger itself, not a summary of it. */
export async function trialChunksFor(gameId: string, buyerAccountId: string) {
  return db.query.sales.findMany({
    where: and(
      eq(sales.gameId, gameId),
      eq(sales.buyerAccountId, buyerAccountId),
      eq(sales.kind, "trial_chunk"),
    ),
  });
}

export type TrialStatus = {
  enabled: boolean;
  chunkPriceUnits: number | null;
  chunkMinutes: number;
  maxChunks: number | null;
  worstCaseUnits: number;
  chunksConsumed: number;
  chunksLeft: number;
  spentUnits: number;
  creditUnits: number;
  /**
   * What buying the game would actually cost this account right now, credit
   * already taken off.
   *
   * Sent rather than left as `price - credit` for the client to work out. The
   * number that moves money is the one `/download` computes, and a second
   * opinion assembled on the other side can only ever disagree with it — it
   * did, in a way nobody noticed: the listing kept showing the full price
   * after a trial because nothing there had been told the credit existed.
   * Both now come from `resolvePurchasePrice`.
   */
  owedUnits: number;
};

/**
 * The whole picture for one game, for one buyer (or nobody, for an anonymous
 * read — the config is public, the numbers about *you* are not).
 */
export async function trialStatusFor(game: Game, buyerAccountId: string | null): Promise<TrialStatus> {
  const enabled = trialEnabled(game);
  const base = {
    enabled,
    chunkPriceUnits: game.trialChunkPriceUnits,
    chunkMinutes: game.trialChunkMinutes,
    maxChunks: game.trialMaxChunks,
    worstCaseUnits: trialWorstCaseUnits(game),
  };

  if (!enabled || !buyerAccountId) {
    return {
      ...base,
      chunksConsumed: 0,
      chunksLeft: game.trialMaxChunks ?? 0,
      spentUnits: 0,
      creditUnits: 0,
      owedUnits: game.priceUnits,
    };
  }

  const chunks = await trialChunksFor(game.id, buyerAccountId);
  const spentUnits = chunks.reduce((sum, s) => sum + s.priceUnits, 0);
  const purchase = await db.query.sales.findFirst({
    where: and(eq(sales.gameId, game.id), eq(sales.buyerAccountId, buyerAccountId), eq(sales.kind, "purchase")),
  });
  const creditUnits = Math.max(0, spentUnits - (purchase?.creditAppliedUnits ?? 0));

  return {
    ...base,
    chunksConsumed: chunks.length,
    chunksLeft: Math.max(0, game.trialMaxChunks! - chunks.length),
    spentUnits,
    creditUnits,
    owedUnits: Math.max(0, game.priceUnits - creditUnits),
  };
}

/**
 * What's left to redeem toward a purchase, on its own — the one number the
 * download route actually needs. Delegates to `trialStatusFor` rather than
 * re-deriving the arithmetic, so there is exactly one place credit is
 * computed. Never negative, and applying it twice is impossible by
 * construction: `creditAppliedUnits` lives on the one `purchase` row a buyer
 * can ever have for a game — entitlement checks refuse a second purchase of
 * something already owned.
 */
export async function availableCreditUnits(game: Game, buyerAccountId: string): Promise<number> {
  if (!trialEnabled(game)) return 0;
  return (await trialStatusFor(game, buyerAccountId)).creditUnits;
}

/**
 * What the download route actually needs: what's still owed after credit,
 * and how much credit that would apply. Pulled out of the route itself so
 * the arithmetic is one small, directly-testable function rather than logic
 * inlined in an HTTP handler — the route's own job is then just wiring this
 * into the x402 challenge and the free-grant edge case.
 */
export async function resolvePurchasePrice(
  game: Game,
  buyerAccountId: string | null,
): Promise<{ owedUnits: number; creditUnits: number }> {
  if (!buyerAccountId || !trialEnabled(game)) return { owedUnits: game.priceUnits, creditUnits: 0 };
  const creditUnits = await availableCreditUnits(game, buyerAccountId);
  return { owedUnits: Math.max(0, game.priceUnits - creditUnits), creditUnits };
}
