/**
 * Applies every migration to a database that has none of them yet, one file
 * per transaction — never all of them in one.
 *
 * **Why this exists instead of `drizzle-kit migrate`.** Drizzle's own
 * migrator (both the CLI and the programmatic `migrate()`) wraps the entire
 * pending batch in a single transaction. That is fine when migrations are
 * applied incrementally, one new file at a deploy, which is how every
 * migration in this repo has actually been run so far. It breaks the moment
 * all of them are replayed at once against a brand-new database — which is
 * exactly what a fresh production deploy does.
 *
 * The concrete failure: migration 0008 does
 * `ALTER TYPE agent_status ADD VALUE 'buying'`, and migration 0017 later
 * recreates that same enum type. Postgres refuses to use a value added by
 * `ALTER TYPE ... ADD VALUE` until the transaction that added it has
 * committed — a real, documented restriction, and already a gotcha in this
 * project's own CLAUDE.md for the "add a value and use it in the same
 * migration" case. Nobody had hit the "two different migrations, replayed
 * together" version of it before, because until now nobody had applied all
 * 23 files to an empty database in one sitting. On dev, 0008 committed on
 * its own weeks before 0017 ever ran, so the restriction never had anything
 * to bite.
 *
 * This runner commits each file before the next one starts, so file N's
 * `ADD VALUE` is always already committed by the time file N+1 might use it
 * — the same guarantee incremental deploys gave for free.
 *
 * Bookkeeping is compatible with drizzle's own: same `drizzle.__drizzle_migrations`
 * table, same `hash`/`created_at` columns, same hash (sha256 of the raw file
 * content). A database partially migrated by this script can be finished by
 * `drizzle-kit migrate` later, and vice versa, because both read the same
 * table the same way.
 *
 * Idempotent the same way drizzle's own migrator is idempotent: skips
 * anything at or before the most recently applied migration's timestamp,
 * rather than checking each file's hash against what's recorded. That match
 * matters here specifically — a hash-based skip would refuse to recognise
 * `0008_faulty_vin_gonzales.sql` as already applied on dev, because dev
 * ran the original version and this file's content has since changed (its
 * value-using index moved out to `0008a`, same reason this whole runner
 * exists). The file changed; whether it already ran did not.
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { Client } from "pg";

const MIGRATIONS_DIR = "./drizzle";
const SCHEMA = "drizzle";
const TABLE = "__drizzle_migrations";

type JournalEntry = { idx: number; when: number; tag: string; breakpoints: boolean };

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set.");

  const journalPath = `${MIGRATIONS_DIR}/meta/_journal.json`;
  if (!existsSync(journalPath)) throw new Error(`No journal at ${journalPath}`);
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: JournalEntry[] };

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  await client.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${SCHEMA}"."${TABLE}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  const already = await client.query(
    `SELECT created_at FROM "${SCHEMA}"."${TABLE}" ORDER BY created_at DESC LIMIT 1`,
  );
  const lastAppliedAt: number | null = already.rows[0] ? Number(already.rows[0].created_at) : null;

  let applied = 0;
  for (const entry of journal.entries) {
    if (lastAppliedAt !== null && entry.when <= lastAppliedAt) {
      console.log(`skip  ${entry.tag} (already applied)`);
      continue;
    }

    const sqlPath = `${MIGRATIONS_DIR}/${entry.tag}.sql`;
    const raw = readFileSync(sqlPath, "utf8");
    const hash = createHash("sha256").update(raw).digest("hex");

    const statements = raw.split("--> statement-breakpoint");
    console.log(`apply ${entry.tag} (${statements.length} statement${statements.length === 1 ? "" : "s"})`);

    await client.query("BEGIN");
    try {
      for (const stmt of statements) {
        const trimmed = stmt.trim();
        if (!trimmed) continue;
        await client.query(trimmed);
      }
      await client.query(
        `INSERT INTO "${SCHEMA}"."${TABLE}" (hash, created_at) VALUES ($1, $2)`,
        [hash, entry.when],
      );
      await client.query("COMMIT");
      applied += 1;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`FAILED on ${entry.tag}:`, err instanceof Error ? err.message : err);
      await client.end();
      process.exit(1);
    }
  }

  console.log(`done — ${applied} migration${applied === 1 ? "" : "s"} applied, ${journal.entries.length - applied} already up to date`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
