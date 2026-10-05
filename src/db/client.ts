import net from "node:net";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.utils.js";

/**
 * **Connect to one address family at a time, not both at once.**
 *
 * Node 18.13+ turns on `autoSelectFamily` by default: every outbound TCP
 * connection races the host's IPv6 and IPv4 addresses ("Happy Eyeballs") and
 * keeps whichever answers first. It is a good default on a working network and
 * actively harmful on a half-working one.
 *
 * Neon publishes **three A and three AAAA records** for a pooled endpoint. On a
 * machine whose IPv6 is dead — not refused, which would fail fast and fall
 * through, but silently blackholed — the race walks into timeouts it cannot
 * distinguish from a slow server, and the whole connection attempt dies. There
 * is no retry that helps, because every attempt does the same thing.
 *
 * Measured from here, repeatedly and in the same process:
 *
 *   default (racing)            FAILED after 20s
 *   autoSelectFamily off        OK in 2546ms
 *   forcing an IPv4 lookup      OK in 1930ms
 *
 * while a raw IPv4 socket to the same host connected in ~270ms every time and a
 * raw IPv6 socket timed out at 20s every time. **This is what every
 * `Connection terminated unexpectedly` and `dbReachable: false` was** — it
 * presents as Neon being down, slow or asleep, and none of those were true.
 *
 * Turning the race off makes Node use the resolver's order and stop, which on
 * this host reaches a working address. It is set here rather than in a start
 * script so the check scripts in `scripts/` get it too: they each open their
 * own pool in their own process, and they are where this was costing the most.
 *
 * Harmless where IPv6 works: it only stops the *racing*, so a host that
 * resolves to a reachable IPv6 address still connects over it.
 */
net.setDefaultAutoSelectFamily(false);

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
  //
  // This was briefly raised to sixty on the theory that a cold Neon compute
  // could not wake inside fifteen. That theory was wrong and the real cause is
  // the `autoSelectFamily` note above: a connection that never completes is not
  // a connection that needs longer. Left at fifteen deliberately.
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
