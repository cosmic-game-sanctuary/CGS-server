import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";
import { env } from "../config/env.js";

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
const pool = new Pool({ connectionString: env.DATABASE_URL_POOLED });

export const db = drizzle(pool, { schema });

export async function pingDb(): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
}
