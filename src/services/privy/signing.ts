import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { PublicKey } from "@hiero-ledger/sdk";
import { privy } from "./client.js";

// The bridge between Privy's signing API and Hedera's.
//
// Hedera signs ECDSA as secp256k1(keccak256(message)) and wants a 64-byte
// compact signature (r||s). Privy's `secp256k1_sign` takes an already-computed
// hash and returns an Ethereum-style hex signature, which is 65 bytes when it
// carries the trailing recovery byte. So: keccak here, hand Privy the hash,
// drop the recovery byte on the way back.
export async function signHederaMessage(walletId: string, message: Uint8Array): Promise<Uint8Array> {
  const hash = keccak_256(message);
  const response = await privy.wallets().rpc(walletId, {
    method: "secp256k1_sign",
    params: { hash: `0x${Buffer.from(hash).toString("hex")}` },
  });

  const raw = Buffer.from(response.data.signature.replace(/^0x/, ""), "hex");
  if (raw.length === 65) return new Uint8Array(raw.subarray(0, 64));
  if (raw.length === 64) return new Uint8Array(raw);
  throw new Error(`unexpected signature length from Privy: ${raw.length} bytes`);
}

// The mirror node reports an account's public key as compressed hex once the
// account exists. Needed because Hedera's signWith() wants the public key
// alongside the signature — Privy never hands us the private half.
export function hederaPublicKeyFromHex(compressedHex: string): PublicKey {
  return PublicKey.fromStringECDSA(compressedHex);
}

/**
 * Which key made this signature, given the address it should belong to.
 *
 * An ECDSA signature carries its own public key: with the message hash, two
 * candidate keys can be recovered from it, and the recovery id says which. This
 * tries both and keeps whichever derives the expected address, so it does not
 * matter how the signer encoded its v byte — Ethereum tooling uses 27/28, plain
 * secp256k1 libraries use 0/1, and Privy is not documented either way.
 *
 * Checking against the address is not a convenience. It is what makes this
 * safe: a signature from any other key recovers to some other address and is
 * refused, so this doubles as proof that the signer holds the wallet it claims.
 *
 * Why it is needed at all: an account that has only ever *received* value has
 * no public key on Hedera. It is a hollow account (HIP-583) whose alias is the
 * 20-byte EVM address, and the Mirror Node reports `key: null` until it signs
 * something. That is every new buyer, so the key has to come from the payment
 * signature itself. Signing the payment is also what completes the account.
 */
export function publicKeyForAddress(
  hash: Uint8Array,
  signatureHex: string,
  expectedEvmAddress: string,
): string | null {
  const raw = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
  if (raw.length !== 64 && raw.length !== 65) return null;

  const rs = raw.subarray(0, 64);
  const want = expectedEvmAddress.replace(/^0x/, "").toLowerCase();

  for (const recid of [0, 1]) {
    try {
      const compressed = secp256k1.recoverPublicKey(
        new Uint8Array(Buffer.concat([Buffer.from([recid]), rs])),
        hash,
        { prehash: false },
      );
      const hex = Buffer.from(compressed).toString("hex");
      if (PublicKey.fromStringECDSA(hex).toEvmAddress().toLowerCase() === want) return hex;
    } catch {
      // A recovery id that doesn't yield a point on the curve. Try the other.
    }
  }
  return null;
}

// Privy's wallet objects carry a `public_key` field in the type definitions,
// but it comes back empty in practice on both create() and get() — verified
// against the real API, not assumed from the types. So the public key is
// derived instead, once, from an actual signature.
//
// Only for wallets this server created, which is the agent's. A person's
// embedded wallet cannot be signed with from here; that key is recovered from
// the payment signature by publicKeyForAddress above.
export async function derivePublicKeyHex(walletId: string, evmAddress: string): Promise<string> {
  const message = new TextEncoder().encode(`cgs:derive-public-key:${walletId}`);
  const hash = keccak_256(message);

  const response = await privy.wallets().rpc(walletId, {
    method: "secp256k1_sign",
    params: { hash: `0x${Buffer.from(hash).toString("hex")}` },
  });

  const publicKeyHex = publicKeyForAddress(hash, response.data.signature, evmAddress);
  if (!publicKeyHex) {
    throw new Error(`could not recover ${evmAddress}'s public key from its own signature`);
  }
  return publicKeyHex;
}
