import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createPrivyHederaSigner } from "./signer.js";
import { AppError } from "../../lib/errors.js";
import { env } from "../../config/env.js";

export type PrivyPayer = { walletId: string; accountId: string; publicKeyHex: string };

// Consumes our own x402-gated download route the same way any external
// client would — build the 402 challenge, sign a payment via Privy, retry.
// Used by both POST /:id/pay (a logged-in buyer, whose browser can't hold a
// signing key) and the wishlist agent. Same function, same code path: an
// agent's purchase and a person's are not two implementations that happen to
// agree, they're the same call.
export async function payForGame(gameId: string, payer: PrivyPayer) {
  const url = `http://127.0.0.1:${env.PORT}/api/games/${gameId}/download`;

  const challenge = await fetch(url);
  if (challenge.status !== 402) {
    if (!challenge.ok) throw new AppError(challenge.status, "PAYMENT_FAILED", "Could not check this game's price.");
    return challenge.json(); // free or already owned — same response shape
  }

  const required = (await challenge.json()) as {
    x402Version: number;
    resource: unknown;
    accepts: Array<Record<string, unknown>>;
  };
  const requirements = required.accepts[0];
  if (!requirements) throw new AppError(500, "PAYMENT_FAILED", "Server offered no payment terms.");

  const signer = createPrivyHederaSigner(payer);
  const scheme = new ExactHederaScheme(signer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { payload } = await scheme.createPaymentPayload(required.x402Version, requirements as any);

  const paymentPayload = {
    x402Version: required.x402Version,
    resource: required.resource,
    accepted: requirements,
    payload,
  };
  const header = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  const paid = await fetch(url, { headers: { "payment-signature": header } });
  const body = (await paid.json()) as { error?: { code?: string; message?: string; details?: unknown } };
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
