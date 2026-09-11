import { and, desc, eq, inArray } from "drizzle-orm";
import {
  TokenMintTransaction,
  TransferTransaction,
  TokenId,
  Hbar,
  AccountId,
} from "@hiero-ledger/sdk";
import { db } from "../../db/client.js";
import {
  games,
  splits,
  gameKeys,
  notifications,
  studios,
  studioMembers,
  sales,
  pendingPayouts,
  users,
} from "../../db/schema.js";
import client from "../hedera/client.js";
import { submitTopicMessage } from "../hedera/hcs.js";
import { getAccountByEvmAddress } from "../hedera/mirror.js";
import { env } from "../../config/env.js";
import logger from "../../utils/logger.utils.js";
import { emailPayoutHeld, emailPayoutSettled, emailSale } from "../email/messages.js";
import { buyerIdentity } from "../users/profile.js";

type Game = typeof games.$inferSelect;

// Everything that happens AFTER the buyer's payment has settled. Deliberately
// off the critical path: settlement is the moment the buyer is entitled to the
// game, so the HTTP response returns immediately and this runs in the
// background. A failure here never costs the buyer their purchase — the
// payment is already final and provable on-chain, and `game_keys.mint_status`
// records what still needs retrying.
//
/**
 * `amountUnits` is what was **actually received**, and every downstream figure
 * is derived from it rather than from `game.priceUnits`.
 *
 * That distinction used to not exist, and it was a live money bug. Splits were
 * computed from the game's price *at the moment the split ran*, which was fine
 * while prices only moved by hand and stopped being fine the moment promotions
 * started moving them on their own: a $2 sale whose split distribution failed
 * and was retried after the promotion reverted would pay out $6 of shares, out
 * of the platform's own account. The mirror case underpaid. Paying out what
 * arrived is the only version that is correct under a price that can change
 * underneath it.
 */
export async function fulfilPurchase(
  game: Game,
  buyerAccountId: string,
  settlementTxId: string,
  amountUnits: number,
  kind: "purchase" | "trial_chunk" = "purchase",
  /** How much of this purchase's price trial credit already covered. Always
   * 0 for a trial_chunk (a chunk cannot redeem credit against itself) — see
   * services/games/trials.ts. */
  creditAppliedUnits = 0,
  /**
   * The account the money actually left, when that is not the account the
   * GameKey goes to. An agent pays from its own wallet on behalf of whoever
   * funded it, so `buyerAccountId` is already the *owner* by the time this is
   * called — which would make the sale notification name the person and never
   * the agent, losing the only half of it that is interesting. Defaults to the
   * buyer, which is every ordinary purchase.
   */
  payerAccountId?: string,
) {
  // The sales row (and, for a real purchase, the gameKeys row), and the caller
  // waits for both. They are what says this person paid — everything below is
  // chain work that can be retried, but until these exist the buyer looks to
  // the rest of the system like someone who hasn't paid. The download route
  // hands back a build the instant it responds, and that request checks the
  // record, so this can't be deferred to the background.
  //
  // A trial chunk gets no gameKeys row — there is nothing to mint a key for,
  // five minutes of access is not ownership, and minting one would make every
  // chunk cost as much chain work as buying the game outright.
  const { sale, key } = await recordPurchase(
    game,
    buyerAccountId,
    settlementTxId,
    amountUnits,
    kind,
    kind === "purchase" ? creditAppliedUnits : 0,
  );
  // Nothing awaits this, so nothing would catch it either. Every step inside
  // handles its own failure; this is the backstop that keeps an unexpected one
  // from taking the process down with it.
  void settleOnChain(game, sale, key, buyerAccountId, settlementTxId, payerAccountId ?? buyerAccountId).catch((err) =>
    logger.error({ err, gameId: game.id, buyerAccountId, kind }, "fulfilment failed after settlement"),
  );
}

async function recordPurchase(
  game: Game,
  buyerAccountId: string,
  settlementTxId: string,
  amountUnits: number,
  kind: "purchase" | "trial_chunk",
  creditAppliedUnits: number,
) {
  const [sale] = await db
    .insert(sales)
    .values({
      gameId: game.id,
      buyerAccountId,
      priceUnits: amountUnits,
      priceAsset: game.priceAsset,
      settlementTxId,
      kind,
      creditAppliedUnits,
    })
    .returning();

  const key =
    kind === "purchase"
      ? (
          await db
            .insert(gameKeys)
            .values({
              tokenId: game.htsTokenId!,
              gameId: game.id,
              ownerAccountId: buyerAccountId,
              mintStatus: "pending",
            })
            .returning()
        )[0]
      : undefined;

  return { sale: sale!, key };
}

/**
 * The mint (skipped for a trial chunk), the split and the sale log. Minutes of
 * chain round trips in the worst case, none of which the buyer should wait
 * for: settlement already happened and is already provable, so a failure here
 * is ours to retry and never costs anyone their purchase.
 */
async function settleOnChain(
  game: Game,
  sale: typeof sales.$inferSelect,
  key: typeof gameKeys.$inferSelect | undefined,
  buyerAccountId: string,
  settlementTxId: string,
  payerAccountId: string,
) {
  if (key) {
    try {
      const serial = await mintAndTransferKey(game, buyerAccountId);
      await db
        .update(gameKeys)
        .set({ serial, mintStatus: "confirmed", mintedAt: new Date(), txId: settlementTxId })
        .where(eq(gameKeys.id, key.id));
    } catch (err) {
      logger.error({ err, gameId: game.id, buyerAccountId }, "GameKey mint failed");
      await db.update(gameKeys).set({ mintStatus: "failed" }).where(eq(gameKeys.id, key.id));
    }
  }

  // the split and the sale log are independent of the mint — a failed mint
  // shouldn't stop the devs getting paid, and vice versa. A failed split is
  // recorded on the sale row rather than just logged — scripts/retry-failed-splits.ts
  // is what actually retries it. There was no way to retry this before Stage 4;
  // it just logged an error and moved on.
  // `sale.priceUnits` rather than `game.priceUnits` throughout: the sale row is
  // the record of what was actually received, and it cannot drift when the
  // listing price moves afterwards.
  await runSplitDistribution(sale.id, game, sale.priceUnits);

  await submitTopicMessage(env.HCS_SALES_TOPIC!, {
    gameId: game.id,
    slug: game.slug,
    buyer: buyerAccountId,
    amountUnits: sale.priceUnits,
    asset: game.priceAsset,
    kind: sale.kind,
    settlementTxId,
    at: new Date().toISOString(),
  })
    .then((hcsTxId) => db.update(sales).set({ hcsSaleTxId: hcsTxId }).where(eq(sales.id, sale.id)))
    .catch((err) => logger.error({ err, gameId: game.id }, "HCS sale log failed"));

  // A studio hearing about every five-minute trial chunk is a spam machine,
  // not a notification — the purchase (or the finished trial converting into
  // one) is the moment worth their attention.
  if (sale.kind === "purchase") {
    await notifyStudio(game, sale.priceUnits, payerAccountId).catch(() => {});
  }
}

async function runSplitDistribution(saleId: string, game: Game, amountUnits: number) {
  if (amountUnits <= 0) {
    // nothing owed on a free game — there's nothing to retry, so it's not
    // "pending" forever, it's just done.
    await db.update(sales).set({ splitStatus: "distributed" }).where(eq(sales.id, saleId));
    return;
  }
  try {
    const { held } = await distributeSplits(game, saleId, amountUnits);
    // "partial" rather than "failed": the money that could move, moved. What
    // is left belongs to someone who hasn't claimed their invite, and it is
    // recorded in pending_payouts rather than lost.
    await db
      .update(sales)
      .set({ splitStatus: held > 0 ? "partial" : "distributed" })
      .where(eq(sales.id, saleId));
  } catch (err) {
    logger.error({ err, gameId: game.id, saleId }, "split distribution failed");
    const message = err instanceof Error ? err.message : String(err);
    await db.update(sales).set({ splitStatus: "failed", splitError: message }).where(eq(sales.id, saleId));
  }
}

async function mintAndTransferKey(game: Game, buyerAccountId: string): Promise<number> {
  const tokenId = TokenId.fromString(game.htsTokenId!);

  const mint = await new TokenMintTransaction()
    .setTokenId(tokenId)
    .setMetadata([new TextEncoder().encode(`cgs:${game.slug}`)])
    .execute(client);
  const receipt = await mint.getReceipt(client);

  const serial = receipt.serials[0];
  if (!serial) throw new Error("mint returned no serial");

  // treasury (the operator) holds the freshly minted serial; move it to the
  // buyer. Privy wallets are alias-created so they have unlimited
  // auto-association under HIP-904 and need no association step.
  const transfer = await new TransferTransaction()
    .addNftTransfer(tokenId, serial, env.HEDERA_OPERATOR_ID, buyerAccountId)
    .execute(client);
  await transfer.getReceipt(client);

  return serial.toNumber();
}

/**
 * Everyone who can be paid, paid in one transaction. Everyone who can't,
 * recorded.
 *
 * The atomicity that matters is still there: the people being paid *now* are
 * paid together or not at all, which is the "nobody chases a teammate for
 * their share" promise. What changed is who counts as a recipient. A split can
 * name someone who has never opened CGS — that is the entire point of adding a
 * collaborator by email — and until they accept the invite, nobody knows an
 * address to pay at all. Treating that as a failure of the whole distribution
 * meant one unclaimed invite stopped everybody's money, which is the opposite
 * of what the product says out loud.
 *
 * So their share is held instead, until they accept — but that is the *only*
 * reason a share is ever held. Once the invite is accepted, their EVM address
 * is known, and that alone is enough to pay them: a token transfer to a fresh
 * alias creates the Hedera account as a side effect (HIP-542), fee on the
 * sender, never taken out of what they're owed. A collaborator who has simply
 * never touched Hedera is paid the moment there's something to pay them —
 * they don't sit waiting on an account that this very payment is what
 * creates. Nothing is ever lost either way: the amounts still total
 * `priceUnits`, and whatever is genuinely held (an unaccepted invite) simply
 * stays in the operator account until it has somewhere to go.
 */
async function distributeSplits(
  game: Game,
  saleId: string,
  amountUnits: number,
): Promise<{ paid: number; held: number }> {
  if (amountUnits <= 0) return { paid: 0, held: 0 };

  const rows = await db.query.splits.findMany({ where: eq(splits.gameId, game.id) });
  if (rows.length === 0) return { paid: 0, held: 0 };

  // Amounts are worked out across every share first, so the split maths is
  // unchanged by who happens to be payable — the remainder still lands on the
  // largest share rather than shifting to whoever has an account today.
  const shares = rows.map((row) => ({
    row,
    amount: Math.floor((amountUnits * row.pct) / 100),
  }));

  // integer division leaves a remainder of at most (recipients - 1) units;
  // give it to the largest share rather than letting it strand in the
  // platform account.
  const allocated = shares.reduce((sum, s) => sum + s.amount, 0);
  const remainder = amountUnits - allocated;
  if (remainder > 0) {
    const largest = shares.reduce((a, b) => (b.amount > a.amount ? b : a));
    largest.amount += remainder;
  }

  const payable: { destination: AccountId; amount: number }[] = [];
  const held: { splitId: string; studioMemberId: string | null; amount: number; reason: string }[] = [];

  for (const share of shares) {
    // Held now means exactly one thing: nobody has told us who this person
    // is yet — `wallet` is still null because the invite hasn't been
    // accepted. The moment it has, we know their EVM address, and that is
    // enough to pay them whether or not they have ever touched Hedera: a
    // token transfer to a fresh alias creates the account as a side effect,
    // the same HIP-542 mechanic every other first-funding moment in this app
    // already relies on, with the creation fee on the sender (us), never
    // taken out of what they're owed. So a known wallet is never held
    // waiting for an account to show up first — it's paid straight to the
    // alias, which *is* the account showing up.
    if (!share.row.wallet) {
      held.push({
        splitId: share.row.id,
        studioMemberId: share.row.studioMemberId,
        amount: share.amount,
        reason: `${share.row.handle} hasn't claimed their invite yet`,
      });
      continue;
    }
    const resolved = await resolveAccountId(share.row.wallet);
    const destination = resolved
      ? AccountId.fromString(resolved)
      : AccountId.fromEvmAddress(0, 0, share.row.wallet);
    payable.push({ destination, amount: share.amount });
  }

  if (payable.length > 0) {
    const total = payable.reduce((sum, r) => sum + r.amount, 0);
    const tx = new TransferTransaction();
    if (game.priceAsset === "0.0.0") {
      tx.addHbarTransfer(env.HEDERA_OPERATOR_ID, Hbar.fromTinybars(-total));
      for (const r of payable) tx.addHbarTransfer(r.destination, Hbar.fromTinybars(r.amount));
    } else {
      const tokenId = TokenId.fromString(game.priceAsset);
      tx.addTokenTransfer(tokenId, env.HEDERA_OPERATOR_ID, -total);
      for (const r of payable) tx.addTokenTransfer(tokenId, r.destination, r.amount);
    }
    const response = await tx.execute(client);
    await response.getReceipt(client);
  }

  if (held.length > 0) {
    await db.insert(pendingPayouts).values(
      held.map((h) => ({
        saleId,
        gameId: game.id,
        splitId: h.splitId,
        studioMemberId: h.studioMemberId,
        amountUnits: h.amount,
        asset: game.priceAsset,
        reason: h.reason,
      })),
    );
    logger.info(
      { gameId: game.id, saleId, held: held.length },
      "some shares are held pending an invite being claimed",
    );
    void announceHeld(game, held).catch((err) =>
      logger.error({ err, gameId: game.id }, "announcing held payouts failed"),
    );
  }

  return { paid: payable.length, held: held.length };
}

/**
 * Pay out everything held for one person — called the moment they accept an
 * invite, since that's the moment their EVM address stops being unknown.
 *
 * Never gated on them already having a Hedera account: `destination` falls
 * back to their EVM alias, which creates the account as a side effect of this
 * very payment (HIP-542) rather than requiring some earlier, unrelated
 * transaction to have done it first. Each payout is settled on its own rather
 * than batched: they belong to different sales, and one bad row should not
 * strand the rest.
 */
export async function settleHeldPayouts(
  studioMemberId: string,
  payee: { accountId?: string | null; evmAddress: string },
): Promise<number> {
  const owed = await db.query.pendingPayouts.findMany({
    where: and(eq(pendingPayouts.studioMemberId, studioMemberId), eq(pendingPayouts.status, "held")),
  });
  if (owed.length === 0) return 0;

  const destination = payee.accountId
    ? AccountId.fromString(payee.accountId)
    : AccountId.fromEvmAddress(0, 0, payee.evmAddress);

  let settled = 0;
  for (const payout of owed) {
    try {
      const tx = new TransferTransaction();
      if (payout.asset === "0.0.0") {
        tx.addHbarTransfer(env.HEDERA_OPERATOR_ID, Hbar.fromTinybars(-payout.amountUnits));
        tx.addHbarTransfer(destination, Hbar.fromTinybars(payout.amountUnits));
      } else {
        const tokenId = TokenId.fromString(payout.asset);
        tx.addTokenTransfer(tokenId, env.HEDERA_OPERATOR_ID, -payout.amountUnits);
        tx.addTokenTransfer(tokenId, destination, payout.amountUnits);
      }
      const response = await tx.execute(client);
      await response.getReceipt(client);

      await db
        .update(pendingPayouts)
        .set({ status: "settled", settledAt: new Date(), settlementTxId: response.transactionId.toString() })
        .where(eq(pendingPayouts.id, payout.id));
      settled += 1;

      // The sale is fully distributed once nothing is still held against it.
      const stillHeld = await db.query.pendingPayouts.findMany({
        where: and(eq(pendingPayouts.saleId, payout.saleId), eq(pendingPayouts.status, "held")),
        columns: { id: true },
      });
      if (stillHeld.length === 0) {
        await db.update(sales).set({ splitStatus: "distributed" }).where(eq(sales.id, payout.saleId));
      }
    } catch (err) {
      logger.error({ err, payoutId: payout.id }, "held payout failed to settle");
      const message = err instanceof Error ? err.message : String(err);
      await db.update(pendingPayouts).set({ status: "failed", reason: message }).where(eq(pendingPayouts.id, payout.id));
    }
  }

  return settled;
}

async function resolveAccountId(wallet: string): Promise<string | null> {
  if (/^\d+\.\d+\.\d+$/.test(wallet)) return wallet;
  const account = await getAccountByEvmAddress(wallet);
  return account?.account ?? null;
}

async function notifyStudio(game: Game, amountUnits: number, payerAccountId: string) {
  const studio = await db.query.studios.findFirst({ where: eq(studios.id, game.studioId) });
  const members = await db.query.studioMembers.findMany({
    where: eq(studioMembers.studioId, game.studioId),
  });
  const userIds = new Set(members.map((m) => m.userId).filter((id): id is string => id !== null));
  userIds.add(studio!.ownerUserId);

  // Each person is told what *they* earned, not what the game sold for. The
  // payload used to carry the full price to everyone, so a row reading "your
  // share is in your wallet" next to it was wrong for every collaborator on a
  // split — and quietly flattering to whoever read it.
  const gameSplits = await db.query.splits.findMany({ where: eq(splits.gameId, game.id) });
  const handleByUser = new Map(
    members.filter((m) => m.userId).map((m) => [m.userId!, m.handle] as const),
  );
  const pctByHandle = new Map(gameSplits.map((s) => [s.handle, s.pct] as const));

  const shareFor = (userId: string) => pctByHandle.get(handleByUser.get(userId) ?? "") ?? null;

  // Who bought it. The one storefront where the buyer is always a resolvable
  // on-chain identity was also the one telling its studios "Unknown bought
  // your game", because the payload carried no buyer at all. Never fatal: a
  // sale that cannot name its buyer is still a sale, and it falls back to the
  // same "Someone" the email always used.
  const buyer = await buyerIdentity(payerAccountId).catch(() => null);

  await db.insert(notifications).values(
    [...userIds].map((userId) => {
      const pct = shareFor(userId);
      return {
        userId,
        type: "sale" as const,
        payload: {
          gameId: game.id,
          slug: game.slug,
          title: game.title,
          priceUnits: amountUnits,
          priceAsset: game.priceAsset,
          // null when this person isn't on the splits — a studio owner who
          // credited the work to other people still wants to know it sold.
          sharePct: pct,
          shareUnits: pct === null ? null : Math.floor((amountUnits * pct) / 100),
          // `displayIdentity`'s order, resolved here rather than on the
          // client: only this side can tell an agent's wallet from a person's.
          buyerLabel: buyer?.label ?? null,
          buyerEns: buyer?.ensName ?? null,
          buyerKind: buyer?.kind ?? null,
          buyerAccountId: payerAccountId,
        },
      };
    }),
  );

  // A sale happens while the studio is asleep as often as not, so the row in
  // the bell is only half of it. Sent after the rows are written, and never
  // awaited into the caller: a sale is a sale whether the receipt arrives.
  const recipients = await db.query.users.findMany({
    where: inArray(users.id, [...userIds]),
    columns: { id: true, email: true },
  });
  for (const person of recipients) {
    const pct = shareFor(person.id);
    void emailSale({
      to: person.email,
      gameTitle: game.title,
      slug: game.slug,
      shareUnits: pct === null ? null : Math.floor((amountUnits * pct) / 100),
      asset: game.priceAsset,
      buyer: buyer?.label ?? null,
    });
  }
}

export { resolveAccountId, distributeSplits };

/**
 * Everything held for this person, across every studio they are on.
 *
 * `settleHeldPayouts` works per membership row, and a person has one of those
 * per studio. Money owed is owed regardless of which team produced it, so the
 * moment someone becomes payable, all of it should move — not just the share
 * from whichever invite they happened to click.
 */
export async function settleHeldPayoutsForUser(
  userId: string,
  payee: { accountId?: string | null; evmAddress: string },
): Promise<number> {
  const memberships = await db.query.studioMembers.findMany({
    where: eq(studioMembers.userId, userId),
    columns: { id: true },
  });
  if (memberships.length === 0) return 0;

  let settled = 0;
  for (const membership of memberships) {
    settled += await settleHeldPayouts(membership.id, payee);
  }

  if (settled > 0) {
    logger.info({ userId, settled }, "settled held payouts for user");
    void announceSettled(userId, settled).catch((err) =>
      logger.error({ err, userId }, "announcing settled payouts failed"),
    );
  }
  return settled;
}

/**
 * Tell both sides a share could not be paid.
 *
 * Held money used to be silent in both directions: the person owed it never
 * learned it existed, and the studio never learned a teammate was unpaid. The
 * collaborator usually has no account yet, so there is no row to write for
 * them — the invite email is the only channel that reaches them at all.
 */
async function announceHeld(
  game: Game,
  held: { studioMemberId: string | null; amount: number; reason: string }[],
): Promise<void> {
  const studio = await db.query.studios.findFirst({ where: eq(studios.id, game.studioId) });
  if (!studio) return;

  const total = held.reduce((sum, h) => sum + h.amount, 0);
  await db.insert(notifications).values({
    userId: studio.ownerUserId,
    type: "payout_held",
    payload: {
      gameId: game.id,
      slug: game.slug,
      title: game.title,
      heldUnits: total,
      priceAsset: game.priceAsset,
      waitingOn: held.length,
      reasons: held.map((h) => h.reason),
    },
  });

  const memberIds = held.map((h) => h.studioMemberId).filter((id): id is string => id !== null);
  if (memberIds.length === 0) return;

  const members = await db.query.studioMembers.findMany({
    where: inArray(studioMembers.id, memberIds),
  });
  for (const member of members) {
    const share = held.find((h) => h.studioMemberId === member.id);
    if (!share) continue;
    // No account means no notification row is possible, so mail is the only
    // way this reaches them — and it is also the nudge to claim the invite.
    void emailPayoutHeld({
      to: member.email,
      handle: member.handle,
      studioName: studio.name,
      gameTitle: game.title,
      inviteId: member.id,
      amountUnits: share.amount,
      asset: game.priceAsset,
      accepted: member.acceptedAt !== null,
    });
  }
}

/** The money arrived. Said once, with the total, not once per payout. */
async function announceSettled(userId: string, count: number): Promise<void> {
  const recent = await db.query.pendingPayouts.findMany({
    where: eq(pendingPayouts.status, "settled"),
    orderBy: desc(pendingPayouts.settledAt),
    limit: count,
  });
  if (recent.length === 0) return;

  const total = recent.reduce((sum, r) => sum + r.amountUnits, 0);
  const asset = recent[0]!.asset;

  await db.insert(notifications).values({
    userId,
    type: "payout_settled",
    payload: { amountUnits: total, priceAsset: asset, payouts: recent.length },
  });

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (user) {
    void emailPayoutSettled({ to: user.email, amountUnits: total, asset, payouts: recent.length });
  }
}
