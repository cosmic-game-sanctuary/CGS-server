// run manually: tsx scripts/retry-failed-splits.ts
//
// Two different things get retried here, and they are not the same problem.
//
// A **failed** sale is one where the whole distribution threw — the network
// rejected it, the operator was short, something went wrong. Retrying re-runs
// the distribution from scratch.
//
// A **held** payout is a share belonging to someone who hasn't claimed their
// invite, so there is no account to pay. That is not a failure and it retries
// itself the moment they accept (see invite.routes.ts). This script settles
// them early only for the case where they *do* now have an account and the
// accept hook didn't run — a wallet funded out of band, say.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { sales, games, pendingPayouts, studioMembers, users } from "../src/db/schema.js";
import { distributeSplits, settleHeldPayouts } from "../src/services/games/fulfil.js";
import { resolveHederaAccount } from "../src/services/users/repo.js";

const failed = await db.query.sales.findMany({ where: eq(sales.splitStatus, "failed") });

if (failed.length === 0) {
  console.log("no failed splits to retry");
} else {
  console.log(`retrying ${failed.length} failed split(s)`);

  for (const sale of failed) {
    const game = await db.query.games.findFirst({ where: eq(games.id, sale.gameId) });
    if (!game) {
      console.log(`sale ${sale.id}: game ${sale.gameId} no longer exists, skipping`);
      continue;
    }

    try {
      const { held } = await distributeSplits(game, sale.id);
      await db
        .update(sales)
        .set({ splitStatus: held > 0 ? "partial" : "distributed", splitError: null })
        .where(eq(sales.id, sale.id));
      console.log(
        `sale ${sale.id} (${game.slug}): ${held > 0 ? `partial, ${held} share(s) held` : "distributed"}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.update(sales).set({ splitError: message }).where(eq(sales.id, sale.id));
      console.log(`sale ${sale.id} (${game.slug}): still failing — ${message}`);
    }
  }
}

// --- held payouts whose person now has an account ------------------------

const held = await db.query.pendingPayouts.findMany({ where: eq(pendingPayouts.status, "held") });

if (held.length === 0) {
  console.log("nothing held");
  process.exit(0);
}

const memberIds = [...new Set(held.map((p) => p.studioMemberId).filter((id): id is string => id !== null))];
const members = memberIds.length
  ? await db.query.studioMembers.findMany({ where: inArray(studioMembers.id, memberIds) })
  : [];

console.log(`\n${held.length} held payout(s) across ${members.length} person/people`);

for (const member of members) {
  if (!member.userId) {
    console.log(`  ${member.handle}: invite not accepted yet, leaving held`);
    continue;
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, member.userId) });
  if (!user) continue;

  const accountId = await resolveHederaAccount(user);
  if (!accountId) {
    console.log(`  ${member.handle}: accepted, but their wallet has never received anything — leaving held`);
    continue;
  }

  const settled = await settleHeldPayouts(member.id, accountId);
  console.log(`  ${member.handle}: settled ${settled} payout(s) to ${accountId}`);
}

// Shares held against a split with no member behind it can't be settled by
// anyone — worth naming rather than counting them as done.
const orphaned = await db.query.pendingPayouts.findMany({
  where: and(eq(pendingPayouts.status, "held"), isNull(pendingPayouts.studioMemberId)),
});
if (orphaned.length > 0) {
  console.log(`\n${orphaned.length} held payout(s) have no studio member attached and need a look`);
}

process.exit(0);
