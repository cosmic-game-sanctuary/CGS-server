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

// Privy's wallet objects carry a `public_key` field in the type definitions,
// but it comes back empty in practice on both create() and get() — verified
// against the real API, not assumed from the types. So the public key is
// derived instead, once, from an actual signature: Privy's secp256k1_sign
// response is 65 bytes (r, s, v) in Ethereum's convention, and an ECDSA
// signature's v byte is exactly what makes the public key recoverable from
// nothing but the signature and the message hash. recid = v - 27, confirmed
// empirically across repeated trials by re-deriving the address from the
// recovered key and diffing it against the wallet's real address — every
// trial matched. Call this once per wallet and cache the result; it's a real
// signing call, not a free lookup.
export async function derivePublicKeyHex(walletId: string): Promise<string> {
  const message = new TextEncoder().encode(`cgs:derive-public-key:${walletId}`);
  const hash = keccak_256(message);

  const response = await privy.wallets().rpc(walletId, {
    method: "secp256k1_sign",
    params: { hash: `0x${Buffer.from(hash).toString("hex")}` },
  });

  const raw = Buffer.from(response.data.signature.replace(/^0x/, ""), "hex");
  if (raw.length !== 65) {
    throw new Error(`expected a 65-byte recoverable signature, got ${raw.length} bytes`);
  }
  const recid = raw[64]! - 27;
  const recoverable = Buffer.concat([Buffer.from([recid]), raw.subarray(0, 64)]);

  const compressed = secp256k1.recoverPublicKey(new Uint8Array(recoverable), hash, { prehash: false });
  return Buffer.from(compressed).toString("hex");
}
