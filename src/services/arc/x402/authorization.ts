import {
  domainSeparator,
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import { arcChain, publicClient, USDC_ADDRESS } from "../client.js";
import { erc20Abi } from "../abis.js";

/**
 * The EIP-3009 authorization a buyer signs, and the only thing they ever sign.
 *
 * This replaces the Hedera build's prepare/sign/settle dance. There, the server
 * had to freeze a transaction before the browser could sign its hashes, because
 * a Hedera transfer is only signable once it exists. An EIP-3009 authorization
 * is a plain typed-data message: it names the recipient, the amount and a
 * deadline, and anyone holding the signature can submit it. So the buyer can
 * sign straight from the 402 challenge, and nothing has to be held in memory
 * between two requests for safety's sake.
 *
 * The signature authorizes exactly one transfer of exactly one amount to exactly
 * one address. It is not an allowance: it cannot be replayed (the nonce is
 * consumed on chain, see `isAuthorizationUsed`) and it cannot be made to pay
 * anyone other than `to`.
 */

export type Authorization = {
  from: Address;
  to: Address;
  /** Atomic USDC units — 6 decimals, the same unit as `games.price_units`. */
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
};

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// Arc's USDC reports name "USDC" and version "2" on chain, and this domain
// reproduces its DOMAIN_SEPARATOR exactly — asserted by
// `assertDomainMatchesChain`, which the Stage 4 check script runs against the
// live contract rather than trusting these strings.
export function usdcDomain(): TypedDataDomain {
  return { name: "USDC", version: "2", chainId: arcChain().id, verifyingContract: USDC_ADDRESS };
}

/** Proves the constants above still describe the deployed token. */
export async function assertDomainMatchesChain(): Promise<void> {
  const onChain = await publicClient().readContract({
    address: USDC_ADDRESS,
    abi: [{ type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }] as const,
    functionName: "DOMAIN_SEPARATOR",
  });
  const computed = domainSeparator({ domain: usdcDomain() });
  if (computed !== onChain) {
    throw new Error(
      `USDC EIP-712 domain mismatch: contract says ${onChain}, we compute ${computed}. ` +
        `Signing with the wrong domain produces signatures the token rejects.`,
    );
  }
}

/** Everything a wallet needs to produce the signature, ready to hand to a client. */
export function typedDataFor(auth: Authorization) {
  return {
    domain: usdcDomain(),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: auth,
  };
}

/** What a client signs over, as a single hash. */
export const authorizationHash = (auth: Authorization): Hex => hashTypedData(typedDataFor(auth));

export function newNonce(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

/**
 * An authorization is good for this long. Deliberately generous: a buyer who
 * opens checkout, reads the splits and then signs is doing nothing wrong, and
 * an expired authorization is a confusing failure for something that is only
 * ever a replay-window bound. Nothing is charged until it is submitted.
 */
export const AUTHORIZATION_TTL_SECONDS = 30 * 60;

export function buildAuthorization(from: Address, to: Address, units: bigint): Authorization {
  const now = Math.floor(Date.now() / 1000);
  return {
    from,
    to,
    value: units,
    // Zero rather than `now`: a validAfter in the future is the one field that
    // can make a correctly-signed authorization fail for a reason the buyer
    // cannot see, if our clock runs ahead of the chain's.
    validAfter: 0n,
    validBefore: BigInt(now + AUTHORIZATION_TTL_SECONDS),
    nonce: newNonce(),
  };
}

export const recoverPayer = (auth: Authorization, signature: Hex): Promise<Address> =>
  recoverTypedDataAddress({ ...typedDataFor(auth), signature });

/** True once the transfer has been submitted; the token refuses it twice. */
export const isAuthorizationUsed = (from: Address, nonce: Hex): Promise<boolean> =>
  publicClient().readContract({
    address: USDC_ADDRESS,
    abi: [{ type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ type: "address" }, { type: "bytes32" }], outputs: [{ type: "bool" }] }] as const,
    functionName: "authorizationState",
    args: [from, nonce],
  });

export type LocalCheck = { ok: true; payer: Address } | { ok: false; reason: string; message: string };

/**
 * Everything worth checking before spending a Circle round trip on it.
 *
 * Circle re-checks all of this and is the authority; the point here is that a
 * buyer with too little USDC, or a signature that does not match the terms we
 * offered, gets told exactly that instead of an opaque facilitator error code.
 * The Hedera build learned this the hard way — see CLAUDE.md on
 * `invalid_exact_hedera_payload_preflight_failed`, where the real reason was
 * computed and then discarded.
 */
export async function checkAuthorizationLocally(
  auth: Authorization,
  signature: Hex,
  expected: { to: Address; units: bigint },
): Promise<LocalCheck> {
  if (auth.to.toLowerCase() !== expected.to.toLowerCase()) {
    return { ok: false, reason: "invalid_exact_evm_payload_recipient_mismatch", message: `This payment pays ${auth.to}, but this game's money goes to ${expected.to}.` };
  }
  if (auth.value !== expected.units) {
    return { ok: false, reason: "invalid_exact_evm_payload_authorization_value_mismatch", message: `This payment authorizes ${auth.value} units; the price is ${expected.units}.` };
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (auth.validAfter > now) {
    return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_after", message: "This payment is not valid yet." };
  }
  if (auth.validBefore <= now) {
    return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_before", message: "This payment authorization has expired. Sign a new one." };
  }

  let payer: Address;
  try {
    payer = await recoverPayer(auth, signature);
  } catch {
    return { ok: false, reason: "invalid_exact_evm_payload_signature", message: "That signature could not be read." };
  }
  // A smart-account buyer signs via ERC-1271 and will not recover to `from`.
  // Circle handles that case; we only reject a recovered-but-wrong EOA, so this
  // never refuses a payment Circle would have accepted.
  if (payer.toLowerCase() !== auth.from.toLowerCase()) {
    const code = await publicClient().getCode({ address: auth.from });
    if (!code || code === "0x") {
      return { ok: false, reason: "invalid_exact_evm_payload_signature", message: "That signature was not made by the wallet it claims to come from." };
    }
  }

  if (await isAuthorizationUsed(auth.from, auth.nonce)) {
    return { ok: false, reason: "invalid_transaction_state", message: "This payment has already been settled." };
  }

  const balance = await publicClient().readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [auth.from] });
  if (balance < auth.value) {
    return { ok: false, reason: "insufficient_funds", message: `That wallet holds ${balance} of the ${auth.value} units this costs.` };
  }

  return { ok: true, payer: auth.from };
}
