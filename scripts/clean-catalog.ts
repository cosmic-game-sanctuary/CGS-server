import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";

/**
 * Take test games out of the public catalog.
 *
 * Every stage's test script created real published games with real slugs, and
 * they are still in the catalog: `agent-game-2-mts5ql1w` sits between two real
 * listings, priced, apparently buyable, and holding a fake HTS token id that
 * makes its mint fail after someone has paid. A judge browsing the storefront
 * sees mostly this.
 *
 * Deliberately **unlists** rather than deletes. A test game may still be
 * referenced by a sale, a game key, a held payout or an agent decision — the
 * exact rows that prove the payment path works — and deleting the game would
 * either fail on a foreign key or destroy that evidence. Unlisting takes it out
 * of the catalog and leaves every record of what happened intact, which is the
 * same reasoning delisting uses for a real game.
 *
 *   npm run catalog:clean          # dry run, lists what it would touch
 *   npm run catalog:clean -- --yes # actually unlist them
 */

const apply = process.argv.includes("--yes");

// A trailing `-mts…` is the timestamp suffix every test script generated.
// Anchored so a real game called "something-mts" by coincidence is safe.
const TEST_SLUG = `slug ~ '-mts[0-9a-z]+$' or slug like 'stage%' or slug like 'splitfix-%' or slug like 'verify-sweep-%'`;

const junk = await db.execute(sql.raw(`
  select id, slug, price_units, hts_token_id
  from games where status = 'published' and (${TEST_SLUG}) order by slug`));

if (junk.rows.length === 0) {
  console.log("catalog is clean — no test games are published");
  process.exit(0);
}

console.log(`${junk.rows.length} test game(s) currently published:\n`);
for (const g of junk.rows as { slug: string; price_units: string; hts_token_id: string | null }[]) {
  // A fake token id is the tell that a purchase here would take money and then
  // fail to mint anything.
  const fake = g.hts_token_id?.startsWith("0.0.9000") ? "  ← fake token, mint would fail" : "";
  console.log(`  ${g.slug.padEnd(26)} $${(Number(g.price_units) / 1e6).toFixed(2)}${fake}`);
}

if (!apply) {
  console.log(`\nDry run. Re-run with --yes to unlist these.`);
  console.log(`Nothing is deleted either way — sales, keys and payouts stay for the audit trail.`);
  process.exit(0);
}

const done = await db.execute(sql.raw(`
  update games set status = 'delisted', delisted_by = 'developer', updated_at = now()
  where status = 'published' and (${TEST_SLUG}) returning slug`));

console.log(`\nunlisted ${done.rows.length} test game(s). Owners of any keys keep them, as always.`);
process.exit(0);
