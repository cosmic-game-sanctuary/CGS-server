/**
 * Pin the zip for any published game that predates `games.build_zip_cid`.
 *
 * Those builds only exist on the disk of the machine that uploaded them, so
 * this normally has to run *there*. If someone sends you the zip instead, the
 * `--file` form below pins it from wherever you are.
 *
 *   npm run builds:backfill                          list and pin what's local
 *   npm run builds:backfill -- --file ./x.zip --slug deadzone
 *
 * Uploads are retried, and one failure never stops the rest: a 20-odd MB
 * upload over a flaky link fails as a bare `TypeError: fetch failed` with no
 * status, which is not a reason to abandon the games after it.
 */
import { eq, and, isNull, isNotNull } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../src/db/client.js";
import { games } from "../src/db/schema.js";
import { pinFile } from "../src/services/ipfs/pinata.js";

const ROOT = path.resolve(process.cwd(), "storage", "builds");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Pinata over a big file fails as a bare "fetch failed" often enough to retry. */
async function pinWithRetry(zip: Buffer, name: string, attempts = 3): Promise<string> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await pinFile(zip, name, "application/zip");
    } catch (err) {
      last = err;
      const detail = err instanceof Error ? err.message : String(err);
      if (attempt < attempts) {
        const wait = attempt * 5000;
        console.log(`        upload attempt ${attempt} failed (${detail}); retrying in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw last;
}

async function pinFor(game: { id: string; slug: string }, zip: Buffer): Promise<boolean> {
  try {
    const cid = await pinWithRetry(zip, `${game.slug}-build.zip`);
    await db.update(games).set({ buildZipCid: cid }).where(eq(games.id, game.id));
    console.log(`  ok    ${game.slug} -> ${cid} (${Math.round(zip.length / 1024)} KB)`);
    return true;
  } catch (err) {
    console.log(`  FAIL  ${game.slug} — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main() {
  const file = arg("file");
  const slug = arg("slug");

  // Pinning a zip somebody sent you, rather than one on this disk.
  if (file || slug) {
    if (!file || !slug) {
      console.error("both --file and --slug are needed together.");
      process.exit(1);
    }
    const game = await db.query.games.findFirst({ where: eq(games.slug, slug) });
    if (!game) {
      console.error(`no game with slug "${slug}".`);
      process.exit(1);
    }
    const zip = await readFile(path.resolve(file));
    if (zip.subarray(0, 2).toString() !== "PK") {
      console.error(`${file} is not a zip.`);
      process.exit(1);
    }
    console.log(`pinning ${file} for ${slug}...`);
    process.exit((await pinFor(game, zip)) ? 0 : 1);
  }

  const pending = await db.query.games.findMany({
    where: and(isNull(games.buildZipCid), isNotNull(games.buildCid)),
    columns: { id: true, slug: true },
  });

  if (pending.length === 0) {
    console.log("nothing to backfill: every game with a build already has a zip pinned.");
    return;
  }

  console.log(`${pending.length} game(s) without a pinned zip.\n`);
  let done = 0;
  const missing: string[] = [];
  const failed: string[] = [];

  for (const game of pending) {
    let zip: Buffer;
    try {
      zip = await readFile(path.resolve(ROOT, `${game.id}.zip`));
    } catch {
      missing.push(game.slug);
      console.log(`  skip  ${game.slug} — no local zip on this machine`);
      continue;
    }
    // One failure must not abandon the games after it.
    if (await pinFor(game, zip)) done += 1;
    else failed.push(game.slug);
  }

  console.log(`\npinned ${done}, no local copy ${missing.length}, failed ${failed.length}`);
  if (missing.length > 0) {
    console.log(`\nNo copy here. Run this where they were published, or have someone send you the`);
    console.log(`zip and pin it directly:`);
    for (const m of missing) console.log(`  npm run builds:backfill -- --file ./${m}.zip --slug ${m}`);
  }
  if (failed.length > 0) {
    console.log(`\nUpload failed after retries (usually the connection, not the file). Just run`);
    console.log(`the command again — anything already pinned is skipped:`);
    for (const f of failed) console.log(`  - ${f}`);
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
