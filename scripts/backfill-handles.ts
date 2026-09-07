import "dotenv/config";
import { eq, isNull } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import { allocateHandle, fallbackHandle } from "../src/lib/handle.js";

/**
 * Give every account that predates profiles a handle.
 *
 * A handle is the address of someone's profile page and the name on every
 * review they have written, so an account without one has no page to link to.
 * New accounts get one at first sign-in and existing ones get one the next time
 * they sign in — this is for doing it now rather than waiting for that, so the
 * catalog's existing reviews and credits stop rendering as addresses.
 *
 * Idempotent: only touches rows where the handle is null.
 *
 *   npm run users:backfill-handles
 */
async function main() {
  const pending = await db.query.users.findMany({ where: isNull(users.handle) });
  if (pending.length === 0) {
    console.log("Everyone already has a handle.");
    return;
  }
  console.log(`${pending.length} account(s) without one.\n`);

  for (const user of pending) {
    const handle = await allocateHandle(fallbackHandle(user.email), user.id);
    await db.update(users).set({ handle }).where(eq(users.id, user.id));
    console.log(`  ok    ${user.evmAddress} -> @${handle}`);
  }
  console.log(`\n${pending.length} backfilled.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
