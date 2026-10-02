import { eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { games, notifications, splits, studioMembers, studios, users } from "../../db/schema.js";
import { buyerIdentity } from "../users/profile.js";
import { emailSale } from "../email/messages.js";

type Game = typeof games.$inferSelect;

/**
 * Telling a studio one of its games sold.
 *
 * Lifted out of the Hedera `fulfil.ts` when that file was deleted, because it is
 * the one part of it that was never about moving money — and so the one part the
 * move to Arc did not make redundant. Everything else in there existed to
 * perform a split the vault now performs itself.
 */
export async function notifyStudio(game: Game, amountUnits: number, payerAccountId: string) {
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
