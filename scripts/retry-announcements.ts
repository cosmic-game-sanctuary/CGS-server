import "dotenv/config";
import { eq, isNull } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { games, gamePriceChanges } from "../src/db/schema.js";
import { announce } from "../src/services/games/listing.js";

/**
 * Re-send price changes that never reached the listings topic.
 *
 * `changePrice` writes the database first and announces second, on purpose: the
 * other order would publish a price nobody can buy at, and an agent watching
 * would fire against a game still charging the old one. The cost of that choice
 * is that a failed announcement leaves a real price change the public topic
 * has never heard about — a row with a null `hcs_tx_id`. This sends those.
 *
 * Safe to run repeatedly. It only touches rows that have no transaction id, and
 * a change that has since been superseded by a newer price is skipped rather
 * than announced late, because announcing a price that is no longer current is
 * worse than never announcing it.
 *
 *   npm run listings:retry
 */
async function main() {
  const pending = await db.query.gamePriceChanges.findMany({
    where: isNull(gamePriceChanges.hcsTxId),
  });

  if (pending.length === 0) {
    console.log("Nothing pending — every price change is on the topic.");
    return;
  }
  console.log(`${pending.length} price change(s) never announced.\n`);

  let sent = 0;
  for (const change of pending.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const game = await db.query.games.findFirst({ where: eq(games.id, change.gameId) });
    if (!game) {
      console.log(`  skip  ${change.id} — the game is gone`);
      continue;
    }
    if (game.status !== "published") {
      console.log(`  skip  ${game.slug} — not published, so it has no listing to correct`);
      continue;
    }
    if (game.priceUnits !== change.toUnits) {
      console.log(`  skip  ${game.slug} — superseded, the price is now ${game.priceUnits}`);
      continue;
    }

    const hcsTxId = await announce(game, "price_changed", { fromUnits: change.fromUnits });
    if (!hcsTxId) {
      console.log(`  fail  ${game.slug} — still can't reach the topic`);
      continue;
    }
    await db.update(gamePriceChanges).set({ hcsTxId }).where(eq(gamePriceChanges.id, change.id));
    console.log(`  ok    ${game.slug} ${change.fromUnits} -> ${change.toUnits}  ${hcsTxId}`);
    sent += 1;
  }

  console.log(`\n${sent} announced.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
