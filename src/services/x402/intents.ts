import { randomUUID } from "node:crypto";
import type { PaymentRequirements } from "@x402/core/types";

/**
 * A payment that has been built but not yet signed.
 *
 * It exists because signing a buyer's purchase takes two round trips: this
 * server builds the transfer (it needs the 402 terms and a Hedera client to do
 * that), the browser signs it (only the browser has authority over the buyer's
 * own wallet), and this server settles it. Something has to hold the frozen
 * transaction in between, and it cannot be the client — a client that can edit
 * the bytes between build and settle can change who gets paid.
 *
 * In memory on purpose. An intent is valid for well under two minutes and is
 * worthless afterwards, so persisting it would mean writing rows whose only
 * possible future is expiry. A restart drops anything in flight, which reads to
 * the buyer as "that took too long, try again" — the same as any other timeout,
 * and no money has moved at that point.
 */

export type PaymentIntent = {
  id: string;
  /** Ours, not Privy's. Whoever prepared it is the only one who may complete it. */
  userId: string;
  gameId: string;
  accountId: string;
  /**
   * Who the signatures must turn out to belong to.
   *
   * Not a public key, because a buyer's account usually doesn't have one on
   * record yet — see privy/signing.ts#publicKeyForAddress. The key is recovered
   * from the signature and checked against this.
   */
  evmAddress: string;
  /** The frozen, unsigned transfer, base64. */
  frozenTx: string;
  /** Every body the wallet has to sign, as hex keccak256 hashes. */
  hashes: string[];
  x402Version: number;
  resource: unknown;
  requirements: PaymentRequirements;
  createdAt: number;
  expiresAt: number;
};

/**
 * A Hedera transaction is valid for 120 seconds from its transaction id's valid
 * start, which is set when the transfer is frozen. Expiring a little before
 * that means a late completion fails here, clearly, instead of at the
 * facilitator as an opaque rejected payment.
 */
const TTL_MS = 100_000;

const intents = new Map<string, PaymentIntent>();

function sweep(now: number): void {
  for (const [id, intent] of intents) {
    if (intent.expiresAt <= now) intents.delete(id);
  }
}

export function createIntent(
  input: Omit<PaymentIntent, "id" | "createdAt" | "expiresAt">,
): PaymentIntent {
  const now = Date.now();
  sweep(now);

  const intent: PaymentIntent = {
    ...input,
    id: randomUUID(),
    createdAt: now,
    expiresAt: now + TTL_MS,
  };
  intents.set(intent.id, intent);
  return intent;
}

/**
 * A live intent this person already has for this game, if any.
 *
 * Double-clicking "Pay" should not build two transfers, because completing both
 * would charge twice for one game. Handing back the intent already in flight
 * makes prepare idempotent for as long as it matters.
 */
export function findLiveIntent(userId: string, gameId: string): PaymentIntent | undefined {
  const now = Date.now();
  for (const intent of intents.values()) {
    if (intent.userId === userId && intent.gameId === gameId && intent.expiresAt > now) {
      return intent;
    }
  }
  return undefined;
}

/**
 * Take an intent out of the store and return it.
 *
 * Removed rather than read, before anything is submitted: a retry of the same
 * intent must not be able to settle a second payment. If settlement then fails,
 * the buyer starts a fresh intent, which is the correct behaviour — the old
 * transaction is the one that already went to the facilitator.
 */
export function consumeIntent(id: string, userId: string): PaymentIntent | undefined {
  const intent = intents.get(id);
  if (!intent) return undefined;
  intents.delete(id);

  if (intent.userId !== userId) return undefined;
  if (intent.expiresAt <= Date.now()) return undefined;
  return intent;
}
