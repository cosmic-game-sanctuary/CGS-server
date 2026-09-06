import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { PaymentRequirements } from "@x402/core/types";
import type { ClientHederaSigner } from "@x402/hedera";
import { createPrivyHederaSigner, presignedSigner } from "./signer.js";
import {
  attachSignatures,
  buildFrozenTransfer,
  signingHashes,
  toCompactSignature,
} from "./transfer.js";
import { consumeIntent, createIntent, findLiveIntent, type PaymentIntent } from "./intents.js";
import { hederaPublicKeyFromHex, publicKeyForAddress } from "../privy/signing.js";
import { AppError } from "../../lib/errors.js";
import { env } from "../../config/env.js";

export type PrivyPayer = { walletId: string; accountId: string; publicKeyHex: string };

// Consumes our own x402-gated download route the same way any external client
// would — read the 402 challenge, sign a payment, retry. Doing it over HTTP
// rather than by calling the handler directly is the point: the gate is the
// same gate for us, an agent, and a stranger's client.
const downloadUrl = (gameId: string) => `http://127.0.0.1:${env.PORT}/api/games/${gameId}/download`;

type Challenge = {
  x402Version: number;
  resource: unknown;
  requirements: PaymentRequirements;
};

/** Either the route wants paying, or it already handed over the goods. */
type ChallengeResult = { paid: false; challenge: Challenge } | { paid: true; body: unknown };

async function readChallenge(gameId: string): Promise<ChallengeResult> {
  const response = await fetch(downloadUrl(gameId));

  if (response.status !== 402) {
    if (!response.ok) {
      throw new AppError(response.status, "PAYMENT_FAILED", "Could not check this game's price.");
    }
    // Free, or the anonymous read already resolved it. Same response shape.
    return { paid: true, body: await response.json() };
  }

  const required = (await response.json()) as {
    x402Version: number;
    resource: unknown;
    accepts: PaymentRequirements[];
  };
  const requirements = required.accepts[0];
  if (!requirements) throw new AppError(500, "PAYMENT_FAILED", "Server offered no payment terms.");

  return {
    paid: false,
    challenge: { x402Version: required.x402Version, resource: required.resource, requirements },
  };
}

/** Sign the challenge with whatever signer, then retry the gated request. */
async function settle(gameId: string, challenge: Challenge, signer: ClientHederaSigner) {
  const scheme = new ExactHederaScheme(signer);
  const { payload } = await scheme.createPaymentPayload(
    challenge.x402Version,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    challenge.requirements as any,
  );

  const header = Buffer.from(
    JSON.stringify({
      x402Version: challenge.x402Version,
      resource: challenge.resource,
      accepted: challenge.requirements,
      payload,
    }),
  ).toString("base64");

  const paid = await fetch(downloadUrl(gameId), { headers: { "payment-signature": header } });
  const body = (await paid.json()) as {
    error?: { code?: string; message?: string; details?: unknown };
  };
  if (!paid.ok) {
    throw new AppError(
      paid.status,
      body.error?.code ?? "PAYMENT_FAILED",
      body.error?.message ?? "Payment failed.",
      body.error?.details,
    );
  }
  return body;
}

/**
 * Buy a game with a wallet this server can sign for.
 *
 * That means the agent's wallet, which we created and therefore have authority
 * over. A person's embedded wallet is not one of these; see preparePayment.
 */
export async function payForGame(gameId: string, payer: PrivyPayer) {
  const result = await readChallenge(gameId);
  if (result.paid) return result.body;
  return settle(gameId, result.challenge, createPrivyHederaSigner(payer));
}

export type PreparedPayment = {
  intentId: string;
  /** Hex keccak256 hashes. Sign every one, in any order. */
  hashes: string[];
  expiresAt: string;
  amountUnits: string;
  asset: string;
};

/**
 * First half of a purchase made by a person: build the transfer, and say what
 * has to be signed.
 *
 * Why it is split at all. The buyer's wallet is a Privy embedded wallet, and
 * Privy will not let this server sign with it — the key belongs to the user,
 * not to us, and the only ways around that are asking them to delegate the
 * wallet or holding an authorization key over it. Both are real features and
 * both are the wrong shape here: this is a storefront, and "authorise the store
 * to move money from your wallet whenever it likes" is a much larger thing to
 * ask than "approve this one purchase".
 *
 * The browser, though, has always been able to sign with the user's own wallet.
 * So the split falls exactly where the authority does. This server does the
 * parts that need the 402 terms and a Hedera client; the browser does the one
 * part that needs the user's key, over a hash, for one transaction it can see
 * the terms of. Nothing is delegated and nothing is held.
 *
 * The public key comes from the Mirror Node rather than from a signing call.
 * A buyer with money has an account, an account has a published key, and asking
 * the wallet to sign something just to learn its own public key was the other
 * thing that needed authority we do not have.
 */
export async function preparePayment(input: {
  userId: string;
  gameId: string;
  accountId: string;
  evmAddress: string;
}): Promise<{ prepared: PreparedPayment } | { granted: unknown }> {
  const existing = findLiveIntent(input.userId, input.gameId);
  if (existing) return { prepared: describe(existing) };

  const result = await readChallenge(input.gameId);
  if (result.paid) return { granted: result.body };

  const { challenge } = result;
  const tx = buildFrozenTransfer(input.accountId, challenge.requirements);
  const frozenTxBytes = tx.toBytes();
  const hashes = await signingHashes(frozenTxBytes);

  const intent = createIntent({
    userId: input.userId,
    gameId: input.gameId,
    accountId: input.accountId,
    evmAddress: input.evmAddress,
    frozenTx: Buffer.from(frozenTxBytes).toString("base64"),
    hashes,
    x402Version: challenge.x402Version,
    resource: challenge.resource,
    requirements: challenge.requirements,
  });

  return { prepared: describe(intent) };
}

function describe(intent: PaymentIntent): PreparedPayment {
  return {
    intentId: intent.id,
    hashes: intent.hashes,
    expiresAt: new Date(intent.expiresAt).toISOString(),
    amountUnits: String(intent.requirements.amount),
    asset: intent.requirements.asset,
  };
}

/**
 * Second half: attach the browser's signatures and settle.
 *
 * The signatures are matched to bodies by hash, so a signature for a hash this
 * transaction does not contain is refused rather than quietly ignored. The
 * intent is consumed before anything is submitted, so a retried request cannot
 * pay twice.
 */
export async function completePayment(input: {
  userId: string;
  gameId: string;
  intentId: string;
  signatures: { hash: string; signature: string }[];
}) {
  const intent = consumeIntent(input.intentId, input.userId);
  if (!intent) {
    throw new AppError(
      409,
      "PAYMENT_INTENT_EXPIRED",
      "That payment took too long to confirm. Nothing was charged.",
    );
  }
  if (intent.gameId !== input.gameId) {
    throw new AppError(409, "PAYMENT_INTENT_EXPIRED", "That payment was for a different game.");
  }

  // Which key signed this, proved rather than assumed. Every signature has to
  // recover to the same key, and that key has to derive the address the intent
  // was built for — so a signature from anywhere else is refused here instead
  // of becoming a payment the network rejects for reasons nobody can read.
  //
  // This is also the only way to learn the key at all for most buyers: an
  // account that has only ever received value has none published. See
  // privy/signing.ts#publicKeyForAddress.
  let publicKeyHex: string | null = null;
  const byHash = new Map<string, Uint8Array>();

  for (const { hash, signature } of input.signatures) {
    const recovered = publicKeyForAddress(
      Buffer.from(hash.replace(/^0x/, ""), "hex"),
      signature,
      intent.evmAddress,
    );
    if (!recovered || (publicKeyHex && recovered !== publicKeyHex)) {
      throw new AppError(
        403,
        "PAYMENT_SIGNATURE_INVALID",
        "That payment wasn't signed by the wallet it's being charged to.",
      );
    }
    publicKeyHex = recovered;
    byHash.set(hash.toLowerCase(), toCompactSignature(signature));
  }

  const publicKey = hederaPublicKeyFromHex(publicKeyHex!);
  const frozenTxBytes = Buffer.from(intent.frozenTx, "base64");

  let signedTx: string;
  try {
    const tx = await attachSignatures(frozenTxBytes, publicKey, byHash);
    signedTx = Buffer.from(tx.toBytes()).toString("base64");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(422, "PAYMENT_SIGNATURE_INVALID", "That signature doesn't fit this payment.", {
      reason: message,
    });
  }

  return settle(
    input.gameId,
    { x402Version: intent.x402Version, resource: intent.resource, requirements: intent.requirements },
    presignedSigner(intent.accountId, signedTx),
  );
}
