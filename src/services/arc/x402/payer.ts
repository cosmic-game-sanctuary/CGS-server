import type { Address, Hex, TypedDataDomain } from "viem";
import { createViemAccount } from "@privy-io/node/viem";
import { privy } from "../../privy/client.js";
import { AppError } from "../../../lib/errors.js";
import {
  buildAuthorization,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  usdcDomain,
  type Authorization,
} from "./authorization.js";
import type { PaymentRequirements, ResourceInfo } from "./requirements.js";

/**
 * Paying for an x402 resource, as a client.
 *
 * The server uses this to consume its *own* gated routes over HTTP — the agent
 * buying a game, a trial chunk metering itself. Doing it as an HTTP client
 * rather than by calling the handler directly is the point: the gate is the same
 * gate for us, for an agent, and for a stranger's client, which is what makes
 * "anyone could build this" true rather than asserted.
 */

/** The only capability a payer needs. A viem `LocalAccount` satisfies this, and so does Privy's. */
export type TypedDataSigner = {
  address: Address;
  signTypedData: (args: {
    domain: TypedDataDomain;
    types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES;
    primaryType: "TransferWithAuthorization";
    message: Authorization;
  }) => Promise<Hex>;
};

/**
 * A Privy-held wallet as a viem account.
 *
 * This is how the agent signs. Privy's own `createViemAccount` returns a real
 * viem `LocalAccount` whose `signTypedData` goes through Privy's signing API, so
 * the agent's EIP-3009 authorizations are produced by exactly the same code path
 * as a local key's — no raw-hash bridge of the kind the Hedera build needed, and
 * no separate signing implementation to keep correct.
 */
export function privyViemAccount(walletId: string, address: Address) {
  return createViemAccount(privy, { walletId, address });
}

export async function signAuthorization(
  signer: TypedDataSigner,
  auth: Authorization,
): Promise<Hex> {
  return signer.signTypedData({
    domain: usdcDomain(),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: auth,
  });
}

/** The `payment-signature` header value: base64 JSON, per x402. */
export function encodePaymentHeader(input: {
  requirements: PaymentRequirements;
  resource: ResourceInfo;
  authorization: Authorization;
  signature: Hex;
}): string {
  const { authorization: a } = input;
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: input.resource,
      accepted: input.requirements,
      payload: {
        signature: input.signature,
        authorization: {
          from: a.from,
          to: a.to,
          value: a.value.toString(),
          validAfter: a.validAfter.toString(),
          validBefore: a.validBefore.toString(),
          nonce: a.nonce,
        },
      },
    }),
  ).toString("base64");
}

type Challenge = { x402Version: number; resource: ResourceInfo; requirements: PaymentRequirements };
type ChallengeResult = { paid: true; body: unknown } | { paid: false; challenge: Challenge };

async function readChallenge(url: string, authorization?: string): Promise<ChallengeResult> {
  // As the buyer, not anonymously: `/download` subtracts the authenticated
  // caller's trial credit, so an anonymous read would quote the full price and
  // quietly bin what they already paid to try the game.
  const res = await fetch(url, authorization ? { headers: { authorization } } : undefined);

  if (res.status !== 402) {
    if (!res.ok) throw new AppError(res.status, "PAYMENT_FAILED", "Could not check the price for this.");
    return { paid: true, body: await res.json() };
  }

  const body = (await res.json()) as { x402Version: number; resource: ResourceInfo; accepts: PaymentRequirements[] };
  const requirements = body.accepts?.[0];
  if (!requirements) throw new AppError(500, "PAYMENT_FAILED", "Server offered no payment terms.");
  return { paid: false, challenge: { x402Version: body.x402Version, resource: body.resource, requirements } };
}

export type PayOptions = {
  /** The buyer's own bearer token, so the gated call is made as them. */
  authorization?: string;
  /**
   * Who the GameKey belongs to, when that is not the payer. An agent pays from
   * its own wallet on behalf of the person who funded it; the route honours this
   * only when the payer really is a known agent.
   */
  ownerAddress?: Address;
};

export type PayResult = { alreadyGranted: boolean; body: unknown; authorization?: Authorization };

/**
 * Read the 402, sign the authorization, retry. One round trip each way.
 *
 * Nothing is held between the two calls: an EIP-3009 authorization is a
 * self-contained message, so unlike the Hedera flow there is no frozen
 * transaction to keep in memory and no window in which a restart loses a
 * payment someone is midway through.
 */
export async function payGatedResource(
  url: string,
  signer: TypedDataSigner,
  options: PayOptions = {},
): Promise<PayResult> {
  const first = await readChallenge(url, options.authorization);
  if (first.paid) return { alreadyGranted: true, body: first.body };

  const { challenge } = first;
  const auth = buildAuthorization(
    signer.address,
    challenge.requirements.payTo,
    BigInt(challenge.requirements.amount),
  );
  const signature = await signAuthorization(signer, auth);

  const headers: Record<string, string> = {
    "payment-signature": encodePaymentHeader({
      requirements: challenge.requirements,
      resource: challenge.resource,
      authorization: auth,
      signature,
    }),
  };
  if (options.ownerAddress) headers["x-owner-address"] = options.ownerAddress;
  if (options.authorization) headers.authorization = options.authorization;

  // A loopback with no timeout once wedged the outer request while the money had
  // already moved, with nothing ever failing. Circle's own wait window is
  // bounded, so this is comfortably past every honest case and short of forever.
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(100_000) }).catch((err) => {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new AppError(
        504,
        "PAYMENT_FAILED",
        "Settlement did not come back in time. The transfer may still have gone through — check the explorer before retrying.",
      );
    }
    throw err;
  });

  const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
  if (!res.ok) {
    throw new AppError(
      res.status,
      body.error?.code ?? "PAYMENT_FAILED",
      body.error?.message ?? "That payment could not be settled.",
      body.error?.details,
    );
  }
  return { alreadyGranted: false, body, authorization: auth };
}
