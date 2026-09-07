import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { games, gamePromotions } from "../../db/schema.js";
import { AppError, Errors } from "../../lib/errors.js";
import { assetDecimals, toDisplayAmount } from "../../lib/display.js";
import { announce, changePrice } from "./listing.js";
import { notifyPriceDrop } from "./wishlist.js";
import logger from "../../utils/logger.utils.js";

type Game = typeof games.$inferSelect;
type Promotion = typeof gamePromotions.$inferSelect;

/**
 * Sales, with an end date and an automatic revert.
 *
 * A "sale" used to be a developer changing a number and remembering to change
 * it back, which is most of why sales barely happened. Two things fall out of
 * making it a record instead:
 *
 *   **The revert is ours.** `endsAt` passing restores the base price without
 *   anyone doing anything.
 *
 *   **The end date is public.** Both the start and the end are ordinary price
 *   changes announced on the listings topic, and the promotional ones carry
 *   `endsAt` in the message. That is what lets anything reading the topic
 *   reason about deadlines instead of guessing — the agent design depends on
 *   it entirely (docs/wishlist-agent-spec.md §4).
 *
 * Everything here goes through `changePrice`, so a promotional price move is
 * the same kind of event as a manual one: same history row, same topic
 * message, same wishlist notifications. A sale is not a special case of price,
 * it is a *scheduled* price.
 */

/** The sale currently running on a game, if any. */
export async function activePromotionFor(gameId: string): Promise<Promotion | undefined> {
  return db.query.gamePromotions.findFirst({
    where: and(eq(gamePromotions.gameId, gameId), eq(gamePromotions.status, "active")),
  });
}

/** Anything that would stop a new promotion being created — one at a time. */
async function pendingOrActiveFor(gameId: string): Promise<Promotion | undefined> {
  return db.query.gamePromotions.findFirst({
    where: and(
      eq(gamePromotions.gameId, gameId),
      inArray(gamePromotions.status, ["scheduled", "active"]),
    ),
  });
}

export type NewPromotion = {
  salePriceUnits: number;
  /** Omit to start immediately. */
  startsAt?: Date;
  endsAt: Date;
  /** Set when reviving an ended sale, so the public record stays honest. */
  supersedesId?: string | null;
};

/**
 * Schedule a sale. Starts immediately if `startsAt` is now or in the past.
 *
 * The base price is captured here rather than read at revert time, because by
 * then the listing price *is* the sale price and the original is gone.
 */
export async function createPromotion(game: Game, input: NewPromotion, byUserId: string) {
  if (game.status !== "published") {
    throw Errors.validationFailed({ game: "only a published game can go on sale" });
  }

  const now = new Date();
  const startsAt = input.startsAt ?? now;

  if (input.endsAt <= startsAt) {
    throw Errors.validationFailed({ endsAt: "a sale has to end after it starts" });
  }
  if (input.endsAt <= now) {
    throw Errors.validationFailed({ endsAt: "that end date has already passed" });
  }
  // A "sale" that raises the price is not a sale, and it would put a price
  // *rise* on the topic labelled as a promotion — which anything reading it
  // would reasonably treat as an offer.
  if (input.salePriceUnits >= game.priceUnits) {
    throw Errors.validationFailed({
      salePriceUnits: `has to be below the current price (${game.priceUnits})`,
    });
  }
  if (input.salePriceUnits < 0) {
    throw Errors.validationFailed({ salePriceUnits: "cannot be negative" });
  }

  const clash = await pendingOrActiveFor(game.id);
  if (clash) {
    throw new AppError(409, "PROMOTION_EXISTS", "This game already has a sale scheduled or running.", {
      promotionId: clash.id,
      status: clash.status,
      endsAt: clash.endsAt,
    });
  }

  const [promotion] = await db
    .insert(gamePromotions)
    .values({
      gameId: game.id,
      salePriceUnits: input.salePriceUnits,
      basePriceUnits: game.priceUnits,
      asset: game.priceAsset,
      startsAt,
      endsAt: input.endsAt,
      status: "scheduled",
      createdByUserId: byUserId,
      supersedesId: input.supersedesId ?? null,
    })
    .returning();

  // Due already, so don't make the caller wait a tick to see it live.
  if (startsAt <= now) {
    const started = await activatePromotion(promotion!);
    return started ?? promotion!;
  }
  return promotion!;
}

/**
 * Put a scheduled promotion live.
 *
 * The status move is a conditional UPDATE rather than a read-then-write, so two
 * schedulers racing cannot both activate the same sale and drop the price
 * twice. Whoever loses the race gets no row back and does nothing.
 */
export async function activatePromotion(promotion: Promotion): Promise<Promotion | null> {
  const [claimed] = await db
    .update(gamePromotions)
    .set({ status: "active", updatedAt: new Date() })
    .where(and(eq(gamePromotions.id, promotion.id), eq(gamePromotions.status, "scheduled")))
    .returning();
  if (!claimed) return null;

  const game = await db.query.games.findFirst({ where: eq(games.id, promotion.gameId) });
  // Unpublished or removed since it was scheduled. Cancel rather than move the
  // price on something that is not on sale to anyone.
  if (!game || game.status !== "published") {
    await db
      .update(gamePromotions)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(gamePromotions.id, claimed.id));
    logger.info({ promotionId: claimed.id }, "promotion cancelled — game is no longer published");
    return null;
  }

  const result = await changePrice(game, claimed.salePriceUnits, claimed.createdByUserId, {
    promotionId: claimed.id,
    // The field the whole deadline design rests on.
    endsAt: claimed.endsAt.toISOString(),
    basePriceUnits: claimed.basePriceUnits,
    saleStarted: true,
  });

  const [withTx] = await db
    .update(gamePromotions)
    .set({ hcsStartTxId: result.change.hcsTxId, updatedAt: new Date() })
    .where(eq(gamePromotions.id, claimed.id))
    .returning();

  // The same notification a manual price drop sends. A sale is a price drop.
  void notifyPriceDrop(result.game, claimed.basePriceUnits, claimed.salePriceUnits).catch((err) =>
    logger.error({ err, promotionId: claimed.id }, "notifying a sale start failed"),
  );

  logger.info(
    { promotionId: claimed.id, gameId: game.id, price: claimed.salePriceUnits },
    "promotion active",
  );
  return withTx!;
}

/**
 * End a running promotion and put the price back.
 *
 * `reason` distinguishes the sale simply finishing from a developer stopping it
 * early; both revert the price identically, and both are announced.
 */
export async function endPromotion(
  promotion: Promotion,
  reason: "ended" | "cancelled",
): Promise<Promotion | null> {
  const [claimed] = await db
    .update(gamePromotions)
    .set({ status: reason, updatedAt: new Date() })
    .where(and(eq(gamePromotions.id, promotion.id), eq(gamePromotions.status, "active")))
    .returning();
  if (!claimed) return null;

  const game = await db.query.games.findFirst({ where: eq(games.id, promotion.gameId) });
  if (!game) return claimed;

  // Nothing to revert if the price is no longer the sale price — a developer
  // repriced by hand in the meantime, and their number wins over ours.
  if (game.priceUnits !== claimed.salePriceUnits) {
    logger.info(
      { promotionId: claimed.id, expected: claimed.salePriceUnits, actual: game.priceUnits },
      "promotion ended but the price had already moved — leaving it alone",
    );
    return claimed;
  }
  if (game.status !== "published") return claimed;

  const result = await changePrice(game, claimed.basePriceUnits, claimed.createdByUserId, {
    promotionId: claimed.id,
    saleEnded: true,
    reason,
  });

  const [withTx] = await db
    .update(gamePromotions)
    .set({ hcsEndTxId: result.change.hcsTxId, updatedAt: new Date() })
    .where(eq(gamePromotions.id, claimed.id))
    .returning();

  logger.info({ promotionId: claimed.id, gameId: game.id, reason }, "promotion over, price restored");
  return withTx!;
}

/** Push a running sale's end date later. Only ever later. */
export async function extendPromotion(promotion: Promotion, endsAt: Date) {
  if (promotion.status !== "active" && promotion.status !== "scheduled") {
    throw Errors.validationFailed({ promotionId: "that sale is over — start a new one instead" });
  }
  if (endsAt <= promotion.endsAt) {
    // Shortening would strand anything that read the original end date off the
    // public topic and planned around it. Ending early is `cancel`, which is
    // announced; silently moving the deadline in is not.
    throw Errors.validationFailed({ endsAt: "can only be moved later — cancel to end a sale early" });
  }

  const [updated] = await db
    .update(gamePromotions)
    .set({ endsAt, updatedAt: new Date() })
    .where(eq(gamePromotions.id, promotion.id))
    .returning();

  const game = await db.query.games.findFirst({ where: eq(games.id, promotion.gameId) });
  // Re-announced so the new deadline is public. A reader that only saw the
  // original end date would otherwise act on a stale one.
  if (game && game.status === "published" && updated!.status === "active") {
    await announce(game, "price_changed", {
      promotionId: updated!.id,
      endsAt: updated!.endsAt.toISOString(),
      fromUnits: game.priceUnits,
      saleExtended: true,
    });
  }

  return updated!;
}

/**
 * The scheduler: start what is due, end what is over.
 *
 * Both halves are driven by conditional UPDATEs, so running this on two
 * processes is safe — the loser of any race simply gets nothing back.
 */
export async function runPromotionTick(): Promise<{ started: number; ended: number }> {
  const now = new Date();

  const due = await db.query.gamePromotions.findMany({
    where: and(eq(gamePromotions.status, "scheduled"), lte(gamePromotions.startsAt, now)),
  });
  let started = 0;
  for (const promotion of due) {
    try {
      if (await activatePromotion(promotion)) started += 1;
    } catch (err) {
      logger.error({ err, promotionId: promotion.id }, "activating a promotion failed");
    }
  }

  const over = await db.query.gamePromotions.findMany({
    where: and(eq(gamePromotions.status, "active"), lte(gamePromotions.endsAt, now)),
  });
  let ended = 0;
  for (const promotion of over) {
    try {
      if (await endPromotion(promotion, "ended")) ended += 1;
    } catch (err) {
      logger.error({ err, promotionId: promotion.id }, "ending a promotion failed");
    }
  }

  return { started, ended };
}

/** Public shape for a promotion, with the display values a client can't derive. */
export function serializePromotion(p: Promotion) {
  return {
    id: p.id,
    status: p.status,
    salePriceUnits: p.salePriceUnits,
    salePriceUsd: toDisplayAmount(p.salePriceUnits, p.asset),
    basePriceUnits: p.basePriceUnits,
    basePriceUsd: toDisplayAmount(p.basePriceUnits, p.asset),
    asset: p.asset,
    assetDecimals: assetDecimals(p.asset),
    percentOff:
      p.basePriceUnits > 0
        ? Math.round(((p.basePriceUnits - p.salePriceUnits) / p.basePriceUnits) * 100)
        : 0,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    hcsStartTxId: p.hcsStartTxId,
    hcsEndTxId: p.hcsEndTxId,
    supersedesId: p.supersedesId,
    createdAt: p.createdAt,
  };
}

/** Every sale a game has ever run, newest first. Public — it is price history. */
export async function promotionHistory(gameId: string) {
  const rows = await db.query.gamePromotions.findMany({
    where: eq(gamePromotions.gameId, gameId),
    orderBy: sql`${gamePromotions.startsAt} DESC`,
  });
  return rows.map(serializePromotion);
}
