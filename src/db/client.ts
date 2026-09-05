import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

// the pooled Neon connection string. migrations use DATABASE_URL (direct)
// instead — see drizzle.config.ts and docs/SETUP.md for why they differ.
// no explicit `ssl` option needed — `sslmode=require` is already in the
// connection string, and pg's own connection-string parser reads that.
const pool = new Pool({ connectionString: process.env.DATABASE_URL_POOLED });

export const db = drizzle(pool, { schema });

export async function pingDb(): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
}
