import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { privy } from "./client.js";

// Deriving a Privy wallet's public key, which Privy itself will not tell us.
//
// This file used to be the bridge between Privy's signing API and Hedera's —
// `signHederaMessage` and `hederaPublicKeyFromHex` lived here and were the only
// reason `@hiero-ledger/sdk` was a dependency. Both are gone: on Arc the agent
// signs through `createViemAccount`, which is an ordinary viem `LocalAccount`,
// so there is no second signing convention to bridge to. What is left is the one
// thing that was never Hedera-specific.
//
// Privy's `secp256k1_sign` returns an Ethereum-style hex signature, 65 bytes
// when it carries the trailing recovery byte. The key is recovered by trying
// both recovery ids and keeping whichever one yields the address we expected,
// which is cheaper and more certain than parsing `v`.
/**
 * An EVM address from a compressed secp256k1 public key.
 *
 * Replaces `PublicKey.fromStringECDSA(hex).toEvmAddress()`, which was the last
 * thing in this repo needing `@hiero-ledger/sdk`. The derivation is not
 * Hedera-specific and never was: decompress the point, drop the `0x04` prefix,
 * keccak the 64 bytes, take the last 20.
 */
function evmAddressFromCompressed(compressedHex: string): string {
  const point = secp256k1.Point.fromHex(compressedHex);
  const uncompressed = point.toBytes(false); // 65 bytes, 0x04-prefixed
  return Buffer.from(keccak_256(uncompressed.subarray(1)).subarray(-20)).toString("hex");
}

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
      if (evmAddressFromCompressed(hex) === want) return hex;
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
