// run manually: tsx scripts/retry-failed-splits.ts
//
// Two different things get retried here, and they are not the same problem.
//
// A **failed** sale is one where the whole distribution threw — the network
// rejected it, the operator was short, something went wrong. Retrying re-runs
// the distribution from scratch.
//
// A **stranded pending** sale is the one this script used to miss entirely.
// `split_status` starts at `pending` and is only moved once distribution has
// run, so a process that dies in between leaves a row that is not `failed`,
// never gets an error written to it, and is invisible to a retry that only
// looks for failures. One sat that way from 2026-09-08 to 2026-09-10: money
// received, team never paid, nothing reporting it. Age is what separates it
// from a sale that is simply mid-distribution right now, the same lease
// reasoning the agent's `claimed_at` uses.
//
// A **held** payout is a share belonging to someone who hasn't claimed their
// invite, so there is no address to pay at all. That is not a failure and it
// retries itself the moment they accept — settleHeldPayouts pays their EVM
// alias directly, account or not, so a held row for someone who *has*
// accepted only means the accept-time attempt itself failed. This script is
// the backstop for that case.
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { sales, games, pendingPayouts, studioMembers, users } from "../src/db/schema.js";
import { distributeSplits, settleHeldPayouts } from "../src/services/games/fulfil.js";
import { resolveHederaAccount } from "../src/services/users/repo.js";

// Ten minutes. A real distribution is a handful of transfers and finishes in
// seconds; anything still `pending` after this is not in flight, it is lost.
const STRANDED_AFTER_MS = 10 * 60 * 1000;
const strandedBefore = new Date(Date.now() - STRANDED_AFTER_MS);

const failed = await db.query.sales.findMany({
  where: or(
    eq(sales.splitStatus, "failed"),
    and(eq(sales.splitStatus, "pending"), lt(sales.createdAt, strandedBefore)),
  ),
});

if (failed.length === 0) {
  console.log("no failed or stranded splits to retry");
} else {
  console.log(`retrying ${failed.length} split(s)`);

  for (const sale of failed) {
    const game = await db.query.games.findFirst({ where: eq(games.id, sale.gameId) });
    if (!game) {
      console.log(`sale ${sale.id}: game ${sale.gameId} no longer exists, skipping`);
      continue;
    }

    try {
      // `sale.priceUnits` — what this buyer actually paid — never the game's
      // price now. This is the exact path the old bug ran down: a retry after
      // a promotion reverted would distribute the restored full price for a
      // sale that was made at the discount, out of the platform's own account.
      const { held } = await distributeSplits(game, sale.id, sale.priceUnits);
      await db
        .update(sales)
        .set({ splitStatus: held > 0 ? "partial" : "distributed", splitError: null })
        .where(eq(sales.id, sale.id));
      console.log(
        `sale ${sale.id} (${game.slug}, was ${sale.splitStatus}): ${held > 0 ? `partial, ${held} share(s) held` : "distributed"}`,
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

  // Not gated on an account already existing — settleHeldPayouts pays their
  // EVM alias directly otherwise, which creates one as a side effect.
  const accountId = await resolveHederaAccount(user);
  const settled = await settleHeldPayouts(member.id, { accountId, evmAddress: user.evmAddress });
  console.log(`  ${member.handle}: settled ${settled} payout(s) to ${accountId ?? `alias ${user.evmAddress}`}`);
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
