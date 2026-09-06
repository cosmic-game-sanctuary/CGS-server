import type { PaymentRequirements } from "@x402/core/types";
import type { ClientHederaSigner } from "@x402/hedera";
import { signHederaMessage, hederaPublicKeyFromHex } from "../privy/signing.js";
import { buildFrozenTransfer } from "./transfer.js";

type PrivyPayer = {
  walletId: string;
  accountId: string;
  publicKeyHex: string;
};

// A ClientHederaSigner backed by a Privy wallet instead of a raw private key.
// @x402/hedera ships createClientHederaSigner(), but it takes a PrivateKey we
// will never hold — Privy keeps it. ClientHederaSigner is a plain structural
// type, so this implements the same contract through Privy's signing API.
//
// This is the path for wallets THIS SERVER can sign with: the agent's, which we
// created. A buyer's own embedded wallet is not one of those — Privy refuses to
// sign with it on our say-so, correctly — so that purchase signs in the browser
// instead and comes back through presignedSigner below. Both build the same
// transaction, from the same function.
export function createPrivyHederaSigner(payer: PrivyPayer): ClientHederaSigner {
  return {
    accountId: payer.accountId,

    async createPartiallySignedTransferTransaction(requirements: PaymentRequirements) {
      const tx = buildFrozenTransfer(payer.accountId, requirements);
      await tx.signWith(hederaPublicKeyFromHex(payer.publicKeyHex), (message) =>
        signHederaMessage(payer.walletId, message),
      );
      return Buffer.from(tx.toBytes()).toString("base64");
    },
  };
}

/**
 * A signer for a transaction that is already signed.
 *
 * The scheme wants to be the thing that produces the payment payload, and it
 * gets there by asking a signer for a transaction. When the signing happened in
 * a browser two HTTP calls ago there is nothing left to sign, so this hands back
 * what we already have and lets the scheme wrap it in whatever payload shape it
 * uses. That keeps the payload format the scheme's business rather than ours.
 *
 * It ignores the requirements it is passed because the transaction was built
 * from exactly those requirements at prepare time and stored beside them. See
 * intents.ts, which is what guarantees that.
 */
export function presignedSigner(accountId: string, signedTxBase64: string): ClientHederaSigner {
  return {
    accountId,
    async createPartiallySignedTransferTransaction() {
      return signedTxBase64;
    },
  };
}
