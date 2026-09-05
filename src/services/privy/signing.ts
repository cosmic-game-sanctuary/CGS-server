import { keccak_256 } from "@noble/hashes/sha3.js";
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
