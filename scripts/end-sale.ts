/**
 * End a running sale immediately.
 *
 * **The operator's escape hatch, deliberately not a button.** A studio winding
 * a sale down through the API gets an hour's notice period, and that is the
 * product rule rather than an inconvenience: a deadline published on a public
 * topic is something buyers and their agents plan around, and an agent that
 * chose to wait for it would lose the game if the price could be pulled from
 * under it. See services/games/promotions.ts#windDownPromotion.
 *
 * A mistake is a different thing from a decision, though. Setting the wrong end
 * date and wanting it gone now is exactly what a script like this is for, and
 * keeping it out of the API is what stops it becoming the normal way to end a
 * sale.
 *
 * Everything a real end does still happens: the base price is restored, the
 * change is announced on the listings topic, and anything watching finds out.
 *
 *   npm run sale:end               # list what is running
 *   npm run sale:end -- <slug>     # end that game's sale now
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { games, gamePromotions } from "../src/db/schema.js";
import { endPromotion } from "../src/services/games/promotions.js";
import { toDisplayAmount } from "../src/lib/display.js";

const slugs = process.argv.slice(2);

async function main() {
  const running = await db.query.gamePromotions.findMany({
    where: inArray(gamePromotions.status, ["active", "scheduled"]),
  });

  if (running.length === 0) {
    console.log("No sale is running or scheduled.");
    return;
  }

  const gameRows = await db.query.games.findMany({
    where: inArray(games.id, running.map((p) => p.gameId)),
    columns: { id: true, slug: true, title: true },
  });
  const gameById = new Map(gameRows.map((g) => [g.id, g]));

  if (slugs.length === 0) {
    console.log("Running or scheduled sales:\n");
    for (const promo of running) {
      const game = gameById.get(promo.gameId);
      const sale = toDisplayAmount(promo.salePriceUnits, promo.asset);
      const base = toDisplayAmount(promo.basePriceUnits, promo.asset);
      console.log(
        `  ${game?.slug ?? promo.gameId}  $${sale.toFixed(2)} (was $${base.toFixed(2)})` +
          `  ${promo.status}, ends ${promo.endsAt.toISOString()}`,
      );
    }
    console.log("\nEnd one now:  npm run sale:end -- <slug>");
    return;
  }

  for (const slug of slugs) {
    const game = gameRows.find((g) => g.slug === slug);
    if (!game) {
      console.error(`  ${slug}: no running sale on that game`);
      continue;
    }
    const promo = running.find((p) => p.gameId === game.id)!;

    if (promo.status === "scheduled") {
      // Never announced, so there is nothing to put back and nobody who could
      // have planned around it.
      await db
        .update(gamePromotions)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(gamePromotions.id, promo.id));
      console.log(`  ${slug}: scheduled sale cancelled before it started`);
      continue;
    }

    const ended = await endPromotion(promo, "cancelled");
    const base = toDisplayAmount(promo.basePriceUnits, promo.asset);
    console.log(
      ended
        ? `  ${slug}: sale ended, price back to $${base.toFixed(2)}, announced on the topic`
        : `  ${slug}: something else ended it first`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
