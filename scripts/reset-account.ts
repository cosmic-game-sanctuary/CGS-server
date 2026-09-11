/**
 * Wipe a test account's footprint so the same email can run a flow again.
 *
 * **Read this before reaching for it.** There is one thing this cannot undo,
 * and it is the thing people usually want: **a GameKey already in a wallet.**
 * `hasEntitlement` asks the Mirror Node first and only falls back to our own
 * `game_keys` table, so deleting rows here changes nothing about whether
 * someone owns a game. The token is minted with a supply key and no wipe key
 * (services/hedera/hts.ts), which is deliberate — a storefront that can
 * confiscate the key it sold is not selling ownership. So the server genuinely
 * cannot take it back, and `/download` will keep short-circuiting to
 * `keyStatus: "owned"` for that wallet forever.
 *
 * **To buy the same game again, use a fresh address instead.** Gmail's
 * plus-addressing gives you unlimited ones that all land in your inbox:
 * `you+t1@gmail.com`, `you+t2@gmail.com`. Privy keys an account on the email
 * string, so each is a different account with a different embedded wallet,
 * which is the only thing that actually clears on-chain ownership.
 *
 * What this *is* good for is everything that lives in our own database, which
 * is most of a test loop: joining a studio again, accepting the same invite
 * again, redoing a wishlist, a want, an agent, a review, a report, a trial.
 *
 *   npm run account:reset                        # list accounts and what they'd lose
 *   npm run account:reset -- you@gmail.com       # dry run, nothing is written
 *   npm run account:reset -- you@gmail.com --yes # do it
 *
 * Flags:
 *   --yes           actually write. Without it this is read-only.
 *   --delete-user   also remove the users row, so the next sign-in is a genuinely
 *                   new record. Refused if they own a studio, because
 *                   `studios.owner_user_id` is NOT NULL and deleting a studio
 *                   would take its games with it.
 *   --drop-agent    delete an agent that still holds money. Without this the
 *                   run stops and tells you to close it from /agent, which
 *                   refunds the balance instead of orphaning it.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../src/db/client.js";
import {
  users,
  studios,
  studioMembers,
  splits,
  pendingPayouts,
  sales,
  gameKeys,
  reviews,
  comments,
  notifications,
  playSessions,
  saveStates,
  wishlistItems,
  wishlistAgents,
  agentDecisions,
  contentReports,
  moderationReports,
  gamePromotions,
  gamePriceChanges,
} from "../src/db/schema.js";
import { resolveHederaAccount } from "../src/services/users/repo.js";
import { agentBalance } from "../src/services/agent/wallet.js";
import { toDisplayAmount } from "../src/lib/display.js";
import { env } from "../src/config/env.js";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const emails = argv.filter((a) => !a.startsWith("--"));
const write = flags.has("--yes");
const deleteUser = flags.has("--delete-user");
const dropAgent = flags.has("--drop-agent");

/** Every count this run would change, in the order it would change them. */
type Tally = { what: string; n: number }[];

function show(tally: Tally) {
  const real = tally.filter((t) => t.n > 0);
  if (real.length === 0) {
    console.log("    nothing to remove");
    return;
  }
  const width = Math.max(...real.map((t) => t.what.length));
  for (const t of real) console.log(`    ${t.what.padEnd(width)}  ${t.n}`);
}

async function listAccounts() {
  const rows = await db.query.users.findMany({ columns: { id: true, email: true, handle: true } });
  if (rows.length === 0) {
    console.log("No accounts.");
    return;
  }
  console.log(`${rows.length} account${rows.length === 1 ? "" : "s"}:\n`);
  for (const u of rows) {
    const [wants, keysRow, memberships] = await Promise.all([
      db.query.wishlistItems.findMany({ where: eq(wishlistItems.userId, u.id), columns: { id: true } }),
      db.query.wishlistAgents.findFirst({ where: eq(wishlistAgents.buyerUserId, u.id), columns: { id: true } }),
      db.query.studioMembers.findMany({ where: eq(studioMembers.userId, u.id), columns: { id: true } }),
    ]);
    const bits = [
      `${wants.length} wishlisted`,
      `${memberships.length} studio${memberships.length === 1 ? "" : "s"}`,
      keysRow ? "has an agent" : "no agent",
    ];
    console.log(`  ${u.email}${u.handle ? `  (@${u.handle})` : ""}`);
    console.log(`    ${bits.join(" · ")}`);
  }
  console.log("\nReset one:  npm run account:reset -- <email>");
}

async function resetOne(email: string) {
  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user) {
    console.error(`  ${email}: no account with that email`);
    return;
  }

  console.log(`\n  ${email}${user.handle ? `  (@${user.handle})` : ""}`);
  console.log(`  ${user.evmAddress}`);

  // Purchases are recorded against a Hedera account id, not a user id, so this
  // is the join for everything money touched. A wallet that never received
  // anything has no account yet, which simply means it never bought anything.
  const accountId = await resolveHederaAccount(user).catch(() => null);
  console.log(`  hedera: ${accountId ?? "none yet"}`);

  const agent = await db.query.wishlistAgents.findFirst({
    where: eq(wishlistAgents.buyerUserId, user.id),
  });

  // Checked before anything is written. An agent's wallet holds real testnet
  // USDC and deleting the row orphans it — recoverable, since we hold the key,
  // but only by someone who knows to go looking. Closing it from /agent
  // refunds properly, so that is the default advice rather than a flag.
  if (agent && !dropAgent) {
    const held = await agentBalance(agent).catch(() => 0n);
    if (held > 0n) {
      console.error(
        `  ! their agent still holds $${toDisplayAmount(Number(held), env.X402_ASSET).toFixed(2)}.\n` +
          `    Close it from /agent first (that refunds it), or pass --drop-agent to delete anyway.`,
      );
      return;
    }
  }

  const ownedStudios = await db.query.studios.findMany({
    where: eq(studios.ownerUserId, user.id),
    columns: { id: true, name: true },
  });
  if (deleteUser && ownedStudios.length > 0) {
    console.error(
      `  ! they own ${ownedStudios.map((s) => s.name).join(", ")}, so the users row cannot go.\n` +
        `    Re-run without --delete-user to reset their activity and keep the studio.`,
    );
    return;
  }

  // Read every count first, so a dry run and a real run print the same thing.
  const mySales = accountId
    ? await db.query.sales.findMany({ where: eq(sales.buyerAccountId, accountId), columns: { id: true } })
    : [];
  const saleIds = mySales.map((s) => s.id);
  const myKeys = accountId
    ? await db.query.gameKeys.findMany({ where: eq(gameKeys.ownerAccountId, accountId), columns: { id: true } })
    : [];
  const myDecisions = agent
    ? await db.query.agentDecisions.findMany({ where: eq(agentDecisions.agentId, agent.id), columns: { id: true } })
    : [];
  const heldPayouts = saleIds.length
    ? await db.query.pendingPayouts.findMany({ where: inArray(pendingPayouts.saleId, saleIds), columns: { id: true } })
    : [];

  const counts = async (table: "wishlistItems" | "reviews" | "comments" | "notifications" | "playSessions" | "saveStates") => {
    const map = { wishlistItems, reviews, comments, notifications, playSessions, saveStates } as const;
    const rows = await db.select({ id: map[table].id }).from(map[table]).where(eq(map[table].userId, user.id));
    return rows.length;
  };

  const memberships = await db.query.studioMembers.findMany({ where: eq(studioMembers.userId, user.id) });
  const myShares = await db.query.splits.findMany({ where: eq(splits.userId, user.id), columns: { id: true } });
  const myContentReports = await db.query.contentReports.findMany({
    where: eq(contentReports.reporterUserId, user.id),
    columns: { id: true },
  });

  const tally: Tally = [
    { what: "wishlist rows (and their wants)", n: await counts("wishlistItems") },
    { what: "reviews", n: await counts("reviews") },
    { what: "comments", n: await counts("comments") },
    { what: "notifications", n: await counts("notifications") },
    { what: "play sessions", n: await counts("playSessions") },
    { what: "cloud saves", n: await counts("saveStates") },
    { what: "content reports", n: myContentReports.length },
    { what: "agent decisions", n: myDecisions.length },
    { what: "agent", n: agent ? 1 : 0 },
    { what: "purchase/trial records", n: mySales.length },
    { what: "held payouts on those sales", n: heldPayouts.length },
    { what: "GameKey records (the token itself stays)", n: myKeys.length },
    { what: "studio memberships un-accepted", n: memberships.length },
    { what: "split shares released to unclaimed", n: myShares.length },
    { what: "users row", n: deleteUser ? 1 : 0 },
  ];
  show(tally);

  if (!write) {
    console.log("  (dry run. add --yes to apply)");
    return;
  }

  // Order matters: children before parents, and anything holding a foreign key
  // to `sales` before the sales themselves.
  await db.delete(saveStates).where(eq(saveStates.userId, user.id));
  await db.delete(playSessions).where(eq(playSessions.userId, user.id));
  await db.delete(comments).where(eq(comments.userId, user.id));
  await db.delete(notifications).where(eq(notifications.userId, user.id));
  await db.delete(wishlistItems).where(eq(wishlistItems.userId, user.id));
  await db.delete(contentReports).where(eq(contentReports.reporterUserId, user.id));
  await db.delete(reviews).where(eq(reviews.userId, user.id));
  // A reply is the studio's, not this person's. Nulling the author keeps the
  // reply on the review it answers instead of deleting somebody else's thread.
  await db
    .update(reviews)
    .set({ developerReplyByUserId: null })
    .where(eq(reviews.developerReplyByUserId, user.id));

  if (agent) {
    await db.delete(agentDecisions).where(eq(agentDecisions.agentId, agent.id));
    await db.delete(wishlistAgents).where(eq(wishlistAgents.id, agent.id));
  }

  if (saleIds.length > 0) {
    await db.delete(pendingPayouts).where(inArray(pendingPayouts.saleId, saleIds));
    await db.delete(sales).where(inArray(sales.id, saleIds));
  }
  if (accountId) {
    await db.delete(gameKeys).where(eq(gameKeys.ownerAccountId, accountId));
  }

  // **The invite, put back.** A studio_members row *is* the invite (see
  // splits.studioMemberId), so clearing who claimed it makes /invite/:id
  // acceptable again by the same person. The row itself stays, because the
  // studio genuinely did invite them and the credit on published games is
  // permanent either way.
  await db
    .update(studioMembers)
    .set({ userId: null, acceptedAt: null })
    .where(eq(studioMembers.userId, user.id));

  // Same reasoning: the share survives, it just goes back to being held for
  // someone who hasn't claimed it, which is what accepting the invite undoes.
  await db.update(splits).set({ userId: null }).where(eq(splits.userId, user.id));

  // Authorship of a price change or a sale is a fact about the game, not about
  // them, so those rows are kept and only the pointer is cleared.
  await db
    .update(gamePromotions)
    .set({ createdByUserId: null })
    .where(eq(gamePromotions.createdByUserId, user.id));
  await db
    .update(gamePriceChanges)
    .set({ changedByUserId: null })
    .where(eq(gamePriceChanges.changedByUserId, user.id));
  await db
    .update(moderationReports)
    .set({ reporterUserId: null })
    .where(eq(moderationReports.reporterUserId, user.id));

  if (deleteUser) {
    await db
      .update(studioMembers)
      .set({ userId: null, acceptedAt: null })
      .where(eq(studioMembers.userId, user.id));
    await db.delete(users).where(eq(users.id, user.id));
  }

  console.log("  done.");

  if (myKeys.length > 0) {
    console.log(
      `  ! this wallet still owns ${myKeys.length} game${myKeys.length === 1 ? "" : "s"} on Hedera.\n` +
        `    Only the records went. To buy those again, sign in with a fresh\n` +
        `    address instead: you+something@gmail.com is a different Privy account.`,
    );
  }
}

async function main() {
  if (emails.length === 0) {
    await listAccounts();
    return;
  }
  if (!write) console.log("Dry run. Nothing will be written.");
  for (const email of emails) await resetOne(email);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
