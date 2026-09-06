import { randomUUID } from "node:crypto";
import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TokenId,
  type Transaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { env } from "../../config/env.js";
import { hederaPublicKeyFromHex, publicKeyForAddress } from "../privy/signing.js";
import { attachSignatures, signingHashes, toCompactSignature } from "../x402/transfer.js";

/**
 * Taking money back out of the wallet Privy made for you.
 *
 * Two things make this different from a purchase, and both are why it is its
 * own module rather than a branch inside the payment path.
 *
 * **The operator pays the fee, not the person withdrawing.** A purchase has
 * its fee covered by the x402 facilitator, so a buyer can hold nothing but
 * USDC and still transact. A withdrawal is an ordinary transfer with no
 * facilitator in it, and requiring HBAR to move your own money out would mean
 * a wallet holding only USDC is a wallet you cannot empty. The transaction id
 * names the operator, which is what makes it the fee payer.
 *
 * **The server still cannot sign for the owner.** Their key is theirs, same as
 * a purchase, so this keeps the same two-step shape: build and freeze here,
 * sign in the browser, submit here.
 */

export type WithdrawIntent = {
  id: string;
  userId: string;
  evmAddress: string;
  fromAccountId: string;
  toAccountId: string;
  asset: string;
  amountUnits: string;
  frozenTx: string;
  hashes: string[];
  expiresAt: number;
};

// Same window as a payment intent and for the same reason: a Hedera
// transaction is valid for 120 seconds from the valid start fixed at freeze
// time, and expiring a little early makes a late completion fail here rather
// than as an opaque network rejection.
const TTL_MS = 100_000;

const intents = new Map<string, WithdrawIntent>();

function client(): Client {
  const c = env.HEDERA_NETWORK === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  c.setMaxNodesPerTransaction(3);
  return c;
}

export async function prepareWithdraw(input: {
  userId: string;
  evmAddress: string;
  fromAccountId: string;
  toAccountId: string;
  asset: string;
  amountUnits: bigint;
}): Promise<WithdrawIntent> {
  const now = Date.now();
  for (const [id, held] of intents) if (held.expiresAt <= now) intents.delete(id);

  const from = AccountId.fromString(input.fromAccountId);
  const to = AccountId.fromString(input.toAccountId);
  const tx = new TransferTransaction();

  if (input.asset === "0.0.0") {
    tx.addHbarTransfer(from, Hbar.fromTinybars((-input.amountUnits).toString()));
    tx.addHbarTransfer(to, Hbar.fromTinybars(input.amountUnits.toString()));
  } else {
    const token = TokenId.fromString(input.asset);
    tx.addTokenTransfer(token, from, -input.amountUnits);
    tx.addTokenTransfer(token, to, input.amountUnits);
  }

  // The operator, so the person withdrawing needs no HBAR of their own.
  tx.setTransactionId(TransactionId.generate(AccountId.fromString(env.HEDERA_OPERATOR_ID)));

  const c = client();
  try {
    tx.freezeWith(c);
  } finally {
    c.close();
  }

  const frozen = tx.toBytes();
  const intent: WithdrawIntent = {
    id: randomUUID(),
    userId: input.userId,
    evmAddress: input.evmAddress,
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    asset: input.asset,
    amountUnits: input.amountUnits.toString(),
    frozenTx: Buffer.from(frozen).toString("base64"),
    hashes: await signingHashes(frozen),
    expiresAt: now + TTL_MS,
  };
  intents.set(intent.id, intent);
  return intent;
}

/**
 * Removed rather than read, before anything is submitted, so retrying the same
 * intent cannot send a second transfer.
 */
export function consumeWithdrawIntent(id: string, userId: string): WithdrawIntent | undefined {
  const intent = intents.get(id);
  if (!intent) return undefined;
  intents.delete(id);
  if (intent.userId !== userId) return undefined;
  if (intent.expiresAt <= Date.now()) return undefined;
  return intent;
}

export async function submitWithdraw(
  intent: WithdrawIntent,
  signatures: { hash: string; signature: string }[],
): Promise<string> {
  const frozen = new Uint8Array(Buffer.from(intent.frozenTx, "base64"));

  // Recovered from the signature rather than looked up, because a wallet that
  // has only ever received value publishes no key (HIP-583). Recovering it and
  // checking it against the address being debited also proves the signer holds
  // that wallet.
  const first = signatures[0];
  if (!first) throw new Error("no signatures were provided");
  const publicKeyHex = publicKeyForAddress(
    new Uint8Array(Buffer.from(first.hash.replace(/^0x/, ""), "hex")),
    first.signature,
    intent.evmAddress,
  );
  if (!publicKeyHex) throw new Error("the signature does not belong to this wallet");

  const byHash = new Map(signatures.map((s) => [s.hash, toCompactSignature(s.signature)]));
  const signed: Transaction = await attachSignatures(
    frozen,
    hederaPublicKeyFromHex(publicKeyHex),
    byHash,
  );

  const c = client();
  try {
    // The owner authorises the debit, the operator pays the fee. Both
    // signatures have to be on it for the transaction to be valid.
    const withFee = await signed.sign(
      PrivateKey.fromStringECDSA(env.HEDERA_OPERATOR_KEY.replace(/^0x/, "")),
    );
    const response = await withFee.execute(c);
    const receipt = await response.getReceipt(c);
    if (receipt.status.toString() !== "SUCCESS") {
      throw new Error(`withdrawal failed on the network: ${receipt.status.toString()}`);
    }
    return response.transactionId.toString();
  } finally {
    c.close();
  }
}
