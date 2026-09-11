import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.utils.js";

// the pooled Neon connection string. migrations use DATABASE_URL (direct)
// instead — see drizzle.config.ts and docs/SETUP.md for why they differ.
// no explicit `ssl` option needed — `sslmode=require` is already in the
// connection string, and pg's own connection-string parser reads that.
//
// reads the validated `env` object, not `process.env` directly — this file
// used to read process.env.DATABASE_URL_POOLED, which worked only because
// every caller happened to import config/env.js (and its `dotenv/config`)
// earlier in the import chain. A script that imports db/client.ts first
// hits `process.env.DATABASE_URL_POOLED` before dotenv has populated it,
// which pg reports as `SASL: client password must be a string` — a
// confusing error for a missing env var. Importing `env` here instead
// makes this module load dotenv itself, regardless of import order.
/**
 * **Connections are kept, not reaped.** `pg` closes an idle client after 10
 * seconds by default, which is a sensible default against a database on the
 * same machine and a severe one against Neon.
 *
 * Measured from Kolkata against `us-east-2`: a warm round trip is ~280ms, and
 * opening a fresh connection costs ~3.5s for TCP, TLS and SCRAM auth. With the
 * default timeout almost every request paid that 3.5s again, because a browser
 * idle for more than ten seconds is the normal case, not the exception. It
 * turned a 3-query route into a ten-second one and made anything with a long
 * sequence of writes, like publishing a game, look broken.
 *
 * `keepAlive` is the other half: without TCP keepalives a connection held open
 * for minutes gets dropped silently by NAT somewhere on the path, and the next
 * query pays the handshake anyway, plus a timeout first.
 *
 * The cost of holding them is a handful of idle server-side connections, which
 * is exactly what a pooled Neon endpoint is built to absorb.
 */
const pool = new Pool({
  connectionString: env.DATABASE_URL_POOLED,
  idleTimeoutMillis: 0,
  keepAlive: true,
  max: 20,
  // **Waiting for a connection is bounded.** `pg` waits forever by default, so
  // once every client is checked out, every other request in the process stops
  // dead with no error and no log line — indistinguishable from a hang, and the
  // hardest possible thing to diagnose from outside. Fifteen seconds is far
  // longer than any healthy checkout here and still fails loudly.
  connectionTimeoutMillis: 15_000,
});

/**
 * Required, not optional, now that connections are held open indefinitely.
 *
 * `pg` emits `error` on the *pool* when a client sitting idle dies under it —
 * Neon suspending an inactive compute, a NAT table forgetting the flow, a
 * network blip. The pool discards that client and carries on, but an `error`
 * event with no listener is an unhandled event, which in Node takes the whole
 * process down. Keeping connections alive for hours makes that a certainty
 * rather than a curiosity, so this is part of the same change.
 */
pool.on("error", (err) => {
  logger.warn({ err }, "an idle database connection died and was discarded");
});

export const db = drizzle(pool, { schema });

export async function pingDb(): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
}
