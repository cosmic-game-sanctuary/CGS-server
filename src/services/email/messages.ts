import { appUrl, sendMail } from "./send.js";
import { toDisplayAmount } from "../../lib/display.js";

/**
 * The four things worth an email, with their wording.
 *
 * Copy lives here rather than at each call site so the voice stays one voice,
 * and so changing a sentence is not a search across routes. Every one of these
 * states a fact and gives one link; none of them ask for anything.
 */

function money(units: number, asset: string): string {
  return toDisplayAmount(units, asset).toFixed(2);
}

/**
 * The only message with no alternative channel. The person receiving it has no
 * account yet, so there is no row to write and no bell to ring — without this
 * an invite is a link nobody was ever handed.
 */
export function emailStudioInvite(input: {
  to: string;
  handle: string;
  studioName: string;
  inviteId: string;
  gameTitle?: string | null;
  pct?: number | null;
}): Promise<boolean> {
  const share =
    input.gameTitle && input.pct
      ? `You are on ${input.pct}% of ${input.gameTitle}.`
      : `You have been added to the team.`;

  return sendMail({
    to: input.to,
    subject: `${input.studioName} added you on Cosmic Game Sanctuary`,
    text: [
      `${input.studioName} added you as ${input.handle}.`,
      ``,
      share,
      `Your share is already set. It was locked when the game published and`,
      `nobody can change it, including us. Accepting is how you claim the`,
      `wallet it pays into.`,
      ``,
      appUrl(`/invite/${input.inviteId}`),
    ].join("\n"),
  });
}

export function emailSale(input: {
  to: string;
  gameTitle: string;
  slug: string;
  shareUnits: number | null;
  asset: string;
}): Promise<boolean> {
  const line =
    input.shareUnits === null
      ? `You are not on the splits for this one.`
      : `Your share, ${money(input.shareUnits, input.asset)}, is already in your wallet.`;

  return sendMail({
    to: input.to,
    subject: `${input.gameTitle} sold`,
    text: [`Someone bought ${input.gameTitle}.`, ``, line, ``, appUrl(`/game/${input.slug}`)].join("\n"),
  });
}

export function emailAgentBought(input: {
  to: string;
  gameTitle: string;
  slug: string;
  priceUnits: number;
  asset: string;
}): Promise<boolean> {
  return sendMail({
    to: input.to,
    subject: `Your buyer got ${input.gameTitle}`,
    text: [
      `${input.gameTitle} dropped to ${money(input.priceUnits, input.asset)} and your buyer took it.`,
      ``,
      `The key is in your wallet. Anything left over went back to you.`,
      ``,
      appUrl(`/library`),
    ].join("\n"),
  });
}

export function emailAgentNeedsFunds(input: {
  to: string;
  gameTitle: string;
  slug: string;
  priceUnits: number;
  balanceUnits: number;
  asset: string;
}): Promise<boolean> {
  const short = money(input.priceUnits - input.balanceUnits, input.asset);
  return sendMail({
    to: input.to,
    subject: `${input.gameTitle} hit your price, but your buyer is short`,
    text: [
      `${input.gameTitle} dropped to ${money(input.priceUnits, input.asset)}.`,
      `Your buyer holds ${money(input.balanceUnits, input.asset)}, so it needs ${short} more.`,
      ``,
      `It is still watching. Top it up and it will buy without you setting`,
      `anything up again.`,
      ``,
      appUrl(`/library`),
    ].join("\n"),
  });
}

/**
 * A share that couldn't be paid yet. The person usually has no account, so
 * there is no notification row that could reach them — this is the only
 * channel, and it doubles as the reason to claim the invite.
 */
export function emailPayoutHeld(input: {
  to: string;
  handle: string;
  studioName: string;
  gameTitle: string;
  inviteId: string;
  amountUnits: number;
  asset: string;
  accepted: boolean;
}): Promise<boolean> {
  const amount = money(input.amountUnits, input.asset);
  const next = input.accepted
    ? [
        `Your wallet has not received anything yet, so there is no account to`,
        `pay into. Send anything to it, or open the site once, and it will go`,
        `out on its own.`,
      ]
    : [`It goes out the moment you claim your place on the team.`];

  return sendMail({
    to: input.to,
    subject: `${amount} is waiting for you from ${input.gameTitle}`,
    text: [
      `${input.gameTitle} sold, and ${amount} of it is yours.`,
      ``,
      ...next,
      ``,
      `Nobody can change your share. It was locked when the game published.`,
      ``,
      appUrl(`/invite/${input.inviteId}`),
    ].join("\n"),
  });
}

export function emailPayoutSettled(input: {
  to: string;
  amountUnits: number;
  asset: string;
  payouts: number;
}): Promise<boolean> {
  const amount = money(input.amountUnits, input.asset);
  const from = input.payouts === 1 ? `a sale` : `${input.payouts} sales`;
  return sendMail({
    to: input.to,
    subject: `${amount} landed in your wallet`,
    text: [
      `${amount} from ${from} was being held because your wallet had no`,
      `account yet. It has one now, so the money has gone out.`,
      ``,
      appUrl(`/library`),
    ].join("\n"),
  });
}

/**
 * The one message a wishlist exists to send.
 *
 * A wishlist that never tells you anything is a list of bookmarks. This is the
 * whole return path: the thing you saved is cheaper now, here is how much, here
 * is the link. It says the old price too, because "20% off" without a number is
 * a marketing sentence and this is meant to be a fact.
 */
export function emailPriceDrop(input: {
  to: string;
  gameTitle: string;
  slug: string;
  fromUnits: number;
  toUnits: number;
  asset: string;
  savedAtUnits?: number | null;
}): Promise<boolean> {
  const percent = input.fromUnits > 0
    ? Math.round(((input.fromUnits - input.toUnits) / input.fromUnits) * 100)
    : 0;
  const sinceYouSaved =
    input.savedAtUnits && input.savedAtUnits > input.toUnits
      ? `You saved it at ${money(input.savedAtUnits, input.asset)}.`
      : null;

  return sendMail({
    to: input.to,
    subject: `${input.gameTitle} is ${percent}% off`,
    text: [
      `${input.gameTitle} dropped from ${money(input.fromUnits, input.asset)} to ${money(input.toUnits, input.asset)}.`,
      ...(sinceYouSaved ? [``, sinceYouSaved] : []),
      ``,
      appUrl(`/game/${input.slug}`),
    ].join("\n"),
  });
}
