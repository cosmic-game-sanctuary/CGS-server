// run manually: tsx scripts/retry-failed-splits.ts
// finds every sale whose split distribution failed (usually because a
// recipient's wallet hadn't received anything on Hedera yet, so no account
// existed to pay) and retries it now that time has passed.
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { sales, games } from "../src/db/schema.js";
import { distributeSplits } from "../src/services/games/fulfil.js";

const failed = await db.query.sales.findMany({ where: eq(sales.splitStatus, "failed") });

if (failed.length === 0) {
  console.log("no failed splits to retry");
  process.exit(0);
}

console.log(`retrying ${failed.length} failed split(s)`);

for (const sale of failed) {
  const game = await db.query.games.findFirst({ where: eq(games.id, sale.gameId) });
  if (!game) {
    console.log(`sale ${sale.id}: game ${sale.gameId} no longer exists, skipping`);
    continue;
  }

  try {
    await distributeSplits(game);
    await db.update(sales).set({ splitStatus: "distributed", splitError: null }).where(eq(sales.id, sale.id));
    console.log(`sale ${sale.id} (${game.slug}): distributed`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(sales).set({ splitError: message }).where(eq(sales.id, sale.id));
    console.log(`sale ${sale.id} (${game.slug}): still failing — ${message}`);
  }
}

process.exit(0);
