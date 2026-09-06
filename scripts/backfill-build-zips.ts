/**
 * Pin the zip for any published game that predates `games.build_zip_cid`.
 *
 * Those builds only exist on the disk of the machine that uploaded them, so
 * this has to run *there* — it can only pin what it can still read. Anything
 * it can't find is reported rather than skipped silently, because the only
 * remaining fix for those is republishing the game.
 */
import { eq, isNull, and, isNotNull } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../src/db/client.js";
import { games } from "../src/db/schema.js";
import { pinFile } from "../src/services/ipfs/pinata.js";

const ROOT = path.resolve(process.cwd(), "storage", "builds");

async function main() {
  const pending = await db.query.games.findMany({
    where: and(isNull(games.buildZipCid), isNotNull(games.buildCid)),
    columns: { id: true, slug: true, title: true },
  });

  if (pending.length === 0) {
    console.log("nothing to backfill: every game with a build already has a zip pinned.");
    return;
  }

  console.log(`${pending.length} game(s) without a pinned zip.\n`);
  let done = 0;
  const missing: string[] = [];

  for (const game of pending) {
    const file = path.resolve(ROOT, `${game.id}.zip`);
    let zip: Buffer;
    try {
      zip = await readFile(file);
    } catch {
      missing.push(`${game.slug} (${game.id})`);
      console.log(`  skip  ${game.slug} — no local zip on this machine`);
      continue;
    }

    const cid = await pinFile(zip, `${game.slug}-build.zip`, "application/zip");
    await db.update(games).set({ buildZipCid: cid }).where(eq(games.id, game.id));
    done += 1;
    console.log(`  ok    ${game.slug} -> ${cid} (${Math.round(zip.length / 1024)} KB)`);
  }

  console.log(`\npinned ${done}, missing ${missing.length}`);
  if (missing.length > 0) {
    console.log("\nThese have no local copy here. Run this on the machine that published them,");
    console.log("or republish the game:");
    for (const m of missing) console.log(`  - ${m}`);
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
