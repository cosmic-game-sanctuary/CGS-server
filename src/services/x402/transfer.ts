import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  PublicKey,
  TokenId,
  Transaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { PaymentRequirements } from "@x402/core/types";
import { env } from "../../config/env.js";

/**
 * The transfer an x402 "exact" payment on Hedera actually is, and the three
 * operations you can do to one.
 *
 * Split out of signer.ts because the buyer's signature and the agent's come
 * from completely different places — a browser and this process — while the
 * transaction they sign is identical. Keeping the build in one function is what
 * makes "an agent's purchase and a person's are the same call" true at the
 * level that matters, rather than two implementations that happen to agree.
 */

/**
 * A frozen transaction carries one body per node it may be submitted to, and
 * every one of those bodies needs its own signature. Left alone, testnet picks
 * seven, which is seven round trips to a wallet that is sitting in a browser
 * on the checkout screen.
 *
 * Three keeps failover — the facilitator can still retry another node if the
 * first is unhealthy — while cutting the signing wait by more than half. There
 * is no correctness cost: a node not in the list simply isn't offered the
 * transaction.
 */
const MAX_NODES_PER_TRANSACTION = 3;

function networkClient(): Client {
  const client = env.HEDERA_NETWORK === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setMaxNodesPerTransaction(MAX_NODES_PER_TRANSACTION);
  return client;
}

/**
 * Build the transfer and freeze it. Frozen means the bytes are final: the
 * transaction id, the node list and the body are all fixed, so a hash taken now
 * is still the right hash when a signature comes back a few seconds later.
 */
export function buildFrozenTransfer(payerAccountId: string, requirements: PaymentRequirements): TransferTransaction {
  const feePayer = requirements.extra?.feePayer;
  if (typeof feePayer !== "string") {
    throw new Error("feePayer missing from paymentRequirements.extra");
  }

  const amount = BigInt(requirements.amount);
  if (amount <= 0n) throw new Error("amount must be greater than zero");

  const accountId = AccountId.fromString(payerAccountId);
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

  // the transaction id's payer is the FACILITATOR, not the buyer — that's what
  // makes the facilitator the fee payer, and it's why the spec makes it verify
  // it's never a net sender of value.
  tx.setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)));

  const client = networkClient();
  try {
    tx.freezeWith(client);
  } finally {
    client.close();
  }
  return tx;
}

/**
 * A key that signs nothing, used to walk a transaction's bodies.
 *
 * `signWith` is the only public way to enumerate them, and it insists on a
 * public key because it means to attach signatures as it goes. The hashes it
 * hands the callback do not depend on that key at all — they are keccak of the
 * body bytes — so a throwaway satisfies the signature without touching the
 * result. Generated once, never leaves this module, never signs.
 */
const BODY_WALKER = PrivateKey.generateECDSA().publicKey;

/**
 * What a wallet has to sign, as hex hashes.
 *
 * A frozen Hedera transaction is not one message but one per node it may be
 * submitted to, each with that node's id baked into the body. So this is a
 * list, and every entry needs its own signature.
 *
 * It runs on a throwaway copy rather than the real transaction, because walking
 * the bodies means attaching junk signatures to them. The copy takes those and
 * is discarded; the bytes handed in are untouched.
 *
 * The hash itself is keccak256 of the body, which is what Hedera signs and what
 * Privy's `secp256k1_sign` takes — see privy/signing.ts.
 */
export async function signingHashes(frozenTxBytes: Uint8Array): Promise<string[]> {
  const scratch = Transaction.fromBytes(frozenTxBytes);
  const hashes: string[] = [];

  await scratch.signWith(BODY_WALKER, async (body) => {
    hashes.push(hexHash(body));
    return new Uint8Array(64);
  });

  return hashes;
}

/**
 * Put signatures made somewhere else onto the transaction they belong to.
 *
 * Matched by hash rather than by position, so the order the signer returned
 * them in cannot silently corrupt a transaction. A missing one throws here,
 * where it reads as what it is, instead of at the facilitator as a rejected
 * payment.
 */
export function attachSignatures(
  frozenTxBytes: Uint8Array,
  publicKey: PublicKey,
  signaturesByHash: Map<string, Uint8Array>,
): Promise<Transaction> {
  const tx = Transaction.fromBytes(frozenTxBytes);
  return tx.signWith(publicKey, async (body) => {
    const hash = hexHash(body);
    const signature = signaturesByHash.get(hash);
    if (!signature) throw new Error(`no signature was provided for ${hash}`);
    return signature;
  });
}

export function hexHash(message: Uint8Array): string {
  return `0x${Buffer.from(keccak_256(message)).toString("hex")}`;
}

/**
 * A 64-byte compact signature (r||s) from whatever hex the signer returned.
 *
 * Privy hands back an Ethereum-style signature, which carries a trailing
 * recovery byte Hedera has no use for. Same normalisation as
 * privy/signing.ts#signHederaMessage, which is where it came from.
 */
export function toCompactSignature(hex: string): Uint8Array {
  const raw = Buffer.from(hex.replace(/^0x/, ""), "hex");
  if (raw.length === 65) return new Uint8Array(raw.subarray(0, 64));
  if (raw.length === 64) return new Uint8Array(raw);
  throw new Error(`expected a 64 or 65 byte signature, got ${raw.length} bytes`);
}
