import {
  AccountId,
  Hbar,
  TokenId,
  TransferTransaction,
  TransactionId,
  Client,
} from "@hiero-ledger/sdk";
import type { PaymentRequirements } from "@x402/core/types";
import type { ClientHederaSigner } from "@x402/hedera";
import { signHederaMessage, hederaPublicKeyFromHex } from "../privy/signing.js";
import { env } from "../../config/env.js";

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
// Both the wishlist agent (its own wallet) and the frontend purchase helper
// (the buyer's wallet) go through this, so a purchase made by software takes
// the exact same code path as one made by a person.
export function createPrivyHederaSigner(payer: PrivyPayer): ClientHederaSigner {
  const accountId = AccountId.fromString(payer.accountId);

  return {
    accountId: accountId.toString(),

    async createPartiallySignedTransferTransaction(requirements: PaymentRequirements) {
      const feePayer = requirements.extra?.feePayer;
      if (typeof feePayer !== "string") {
        throw new Error("feePayer missing from paymentRequirements.extra");
      }

      const amount = BigInt(requirements.amount);
      if (amount <= 0n) throw new Error("amount must be greater than zero");

      const payTo = AccountId.fromString(requirements.payTo);
      const tx = new TransferTransaction();

      if (requirements.asset === "0.0.0") {
        tx.addHbarTransfer(accountId, Hbar.fromTinybars((-amount).toString()));
        tx.addHbarTransfer(payTo, Hbar.fromTinybars(amount.toString()));
      } else {
        const tokenId = TokenId.fromString(requirements.asset);
        tx.addTokenTransfer(tokenId, accountId, -amount);
        tx.addTokenTransfer(tokenId, payTo, amount);
      }

      // the transaction id's payer is the FACILITATOR, not the buyer — that's
      // what makes the facilitator the fee payer, and it's why the spec makes
      // it verify it's never a net sender of value.
      tx.setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)));

      const client =
        env.HEDERA_NETWORK === "mainnet" ? Client.forMainnet() : Client.forTestnet();
      try {
        tx.freezeWith(client);
        await tx.signWith(hederaPublicKeyFromHex(payer.publicKeyHex), (message) =>
          signHederaMessage(payer.walletId, message),
        );
        return Buffer.from(tx.toBytes()).toString("base64");
      } finally {
        client.close();
      }
    },
  };
}
