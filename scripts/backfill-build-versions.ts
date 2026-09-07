import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { games, gameBuilds } from "../src/db/schema.js";

/**
 * Give every game published before build versioning existed its version 1 row.
 *
 * Until now a game had exactly one build and the CIDs lived only on the `games`
 * row. The history table is what makes a patch possible, and a game with an
 * empty history would have its *next* build numbered 1 — colliding with the
 * version the listing already claims to be serving. This copies what is
 * already there into the history so the next upload is honestly version 2.
 *
 * Idempotent: a game that already has any build row is skipped.
 *
 *   npm run builds:backfill-versions
 */
async function main() {
  const all = await db.query.games.findMany();
  console.log(`${all.length} game(s).\n`);

  let written = 0;
  for (const game of all) {
    const existing = await db.query.gameBuilds.findFirst({ where: eq(gameBuilds.gameId, game.id) });
    if (existing) {
      console.log(`  skip  ${game.slug} — already has a build history`);
      continue;
    }
    if (!game.buildCid) {
      console.log(`  skip  ${game.slug} — no build pinned`);
      continue;
    }

    await db.insert(gameBuilds).values({
      gameId: game.id,
      version: 1,
      // Deliberately unlabelled: we do not know what the developer called this
      // one, and inventing "v1" would put words in their mouth on a page that
      // is meant to be a record.
      label: null,
      notes: null,
      buildCid: game.buildCid,
      buildZipCid: game.buildZipCid,
      buildSizeKb: game.buildSizeKb,
      // Published before the topic carried build messages, so there is no
      // announcement to point at. Null is the truthful answer.
      hcsTxId: null,
      createdAt: game.publishedAt ?? game.createdAt,
    });
    await db.update(games).set({ buildVersion: 1 }).where(eq(games.id, game.id));
    console.log(`  ok    ${game.slug} -> v1 (${game.buildCid})`);
    written += 1;
  }

  console.log(`\n${written} backfilled.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
