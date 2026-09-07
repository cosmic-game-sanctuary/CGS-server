/**
 * Take a game out of the catalog.
 *
 * **Delist, never delete.** A published game may have real sales behind it and
 * real GameKeys minted to real accounts — deleting the row would erase a
 * purchase someone actually made and leave a token pointing at nothing. The
 * product rule is the same one the state machine enforces everywhere else:
 * delisting removes a game from the catalog and never revokes anyone's copy.
 * Anyone holding a key keeps it and can still play.
 *
 * Use it for test listings that shouldn't be in front of a judge. If a build
 * is genuinely unplayable because it predates `build_zip_cid`, prefer
 * `npm run builds:backfill` on the machine that published it — that fixes it
 * rather than hiding it.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { games, sales } from "../src/db/schema.js";

const slugs = process.argv.slice(2);

async function main() {
  if (slugs.length === 0) {
    const published = await db.query.games.findMany({
      where: eq(games.status, "published"),
      columns: { slug: true, title: true, buildZipCid: true },
    });
    console.log("Published games:\n");
    for (const g of published) {
      const retrievable = g.buildZipCid ? "playable anywhere" : "only on the machine that published it";
      console.log(`  ${g.slug.padEnd(24)} ${g.title}  (${retrievable})`);
    }
    console.log(`\nUsage: npm run game:delist -- <slug> [slug...]`);
    return;
  }

  for (const slug of slugs) {
    const game = await db.query.games.findFirst({ where: eq(games.slug, slug) });
    if (!game) {
      console.log(`  skip  ${slug} — no such game`);
      continue;
    }
    if (game.status === "delisted") {
      console.log(`  skip  ${slug} — already delisted`);
      continue;
    }

    const sold = await db.query.sales.findMany({ where: eq(sales.gameId, game.id), columns: { id: true } });
    // Marked as a moderation delisting: this script is an operator tool, and
    // POST /api/games/:id/relist deliberately refuses to undo one of those.
    await db
      .update(games)
      .set({ status: "delisted", delistedBy: "moderation", updatedAt: new Date() })
      .where(eq(games.id, game.id));
    console.log(
      `  ok    ${slug} delisted` +
        (sold.length > 0 ? ` — ${sold.length} buyer(s) keep their key and can still play it` : ""),
    );
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
