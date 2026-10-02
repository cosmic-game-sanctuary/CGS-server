import { type Address, type Hex } from "viem";
import { identityRegistryAbi } from "../arc/abis.js";
import {
  agentRegistryId,
  clientFor,
  confirm,
  feeOverrides,
  identityRegistryAddress,
  publicClient,
  withGasHeadroom,
} from "../arc/client.js";
import { privyViemAccount } from "../arc/x402/payer.js";
import logger from "../../utils/logger.utils.js";

/**
 * The agent's identity, as a standard instead of a string we invented.
 *
 * **What this replaces, and why the old thing existed.** The Hedera build
 * hand-derived an HCS-14 `uaid:aid:…` identifier — SHA-384 over canonical JSON,
 * Base58 — and published it as a message on an HCS topic. That was not a
 * shortcut: `@hashgraphonline/standards-sdk` was tried first and its install
 * never finished, and the AID spec explicitly allows offline derivation, so the
 * derivation was implemented directly rather than depended on. It worked, and it
 * was still ours: a format we computed, on a topic we owned, which anyone had to
 * take our word for the meaning of.
 *
 * ERC-8004 is the same claim made in a way that needs no word from us.
 * Registering **mints an ERC-721** on a registry we did not deploy and do not
 * control, at a per-chain singleton address. The token id *is* the agent id, the
 * token's owner is the agent, and both are readable with one `eth_call` by
 * anyone. "The agent has its own on-chain identity" stops being a sentence in a
 * README and becomes a token you can look up.
 *
 * Spec: https://eips.ethereum.org/EIPS/eip-8004
 */

/**
 * Our own metadata keys. `agentWallet` is reserved by the spec; these are not.
 *
 * **Values are stored in their natural ABI encoding**, not as text — an address
 * as its 20 bytes, a number as a 32-byte big-endian word. One rule with no
 * exceptions, so a contract could read either without knowing which of our keys
 * it was looking at. The first version of this used viem's `toHex` on the
 * address, which encodes the *characters* "0x42…" as UTF-8 and produced 42 bytes
 * of ASCII that happened to be readable and was not an address at all.
 */
export const FUNDING_PRINCIPAL_KEY = "cgs:fundingPrincipal";
export const MAX_SPEND_KEY = "cgs:maxSpendUnits";

type AgentWallet = { id: string; agentWalletId: string; agentEvmAddress: string };

/**
 * The agent's registration file, built to the spec's `registration-v1` shape.
 *
 * Served as a `data:` URI rather than from IPFS or from our own API, which is a
 * deliberate choice and the strongest version of the claim: the entire identity
 * is *on Arc*, so resolving it needs no gateway, no pin that could lapse, and no
 * server of ours that could be down or could quietly serve something else. It
 * costs more gas than a 60-byte `ipfs://` link, and a few tenths of a cent is a
 * fair price for an identity with no retrieval dependency at all.
 */
function registrationFile(input: {
  agentId: bigint | null;
  buyerAddress: string;
  appUrl: string;
}): string {
  const file = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "cgs-wishlist-agent",
    description:
      "Buys games on Cosmic Game Sanctuary for the person who funded it, when a game on their " +
      "wishlist drops to a price they set. Learns about listings from the GameRegistry contract's " +
      "events, never from a private database. Pays with x402 over EIP-3009.",
    services: [{ name: "web", endpoint: input.appUrl }],
    // True and load-bearing: this agent's purchases and its own inference
    // charges both settle over x402.
    x402Support: true,
    active: true,
    // Self-referential by design — it lets a reader who has this file confirm
    // which on-chain agent it belongs to. Null only in the moment between
    // minting and naming the token, which is why the URI is written second.
    registrations:
      input.agentId === null
        ? []
        : [{ agentId: Number(input.agentId), agentRegistry: agentRegistryId() }],
    // Empty on purpose. The spec says an empty list means this registration is
    // used for discovery only, which is honest: nothing here is staked, there is
    // no validator, and claiming a trust model we do not implement would be
    // exactly the kind of thing this file exists to make unnecessary.
    supportedTrust: [] as string[],
    // Not part of the spec, and prefixed so it cannot be mistaken for it. The
    // human behind the wallet, which was the whole point of the HCS-14 anchor
    // this replaces.
    "cgs:fundingPrincipal": input.buyerAddress,
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(file)).toString("base64")}`;
}

export type Registration = { agentId: bigint; registerTx: Hex; uriTx: Hex };

/**
 * Register the agent, paid for by the agent's own wallet.
 *
 * **The agent registers itself, and owns its own token.** The alternative was
 * minting to the buyer, which reads better until you work it through: the
 * transaction has to be signed by someone, we cannot sign for a buyer's embedded
 * wallet (the Stage 4 lesson), and the spec sets the reserved `agentWallet`
 * metadata to the minter — so minting to the buyer would name the *buyer's*
 * address as where the agent transacts from, which is false. Transferring
 * afterwards clears `agentWallet` and needs the new owner's signature to restore
 * it, which we also cannot produce. So the agent owns itself, `agentWallet` is
 * correct without any extra call, and the buyer is named in metadata instead.
 *
 * Two transactions, because the registration file has to state its own agent id
 * and that id does not exist until the first one returns. Simulating `register`
 * to predict the id was the one-transaction alternative and was rejected: ids are
 * assigned incrementally, so anyone registering in between would shift it and the
 * file would confidently name the wrong agent.
 */
export async function registerAgentIdentity(
  agent: AgentWallet,
  buyerAddress: string,
): Promise<Registration> {
  const account = await privyViemAccount(agent.agentWalletId, agent.agentEvmAddress as Address);
  const wallet = clientFor(account);
  const client = publicClient();
  const registry = identityRegistryAddress();

  // The funding principal rides along with the mint rather than taking a
  // transaction of its own. It never changes, so unlike the spending ceiling it
  // has no reason to be written again later.
  const { request, result: agentId } = await client.simulateContract({
    account,
    address: registry,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [
      "",
      // The address itself, which is already exactly 20 bytes of hex.
      [{ metadataKey: FUNDING_PRINCIPAL_KEY, metadataValue: buyerAddress as Hex }],
    ],
    ...(await feeOverrides()),
  });
  const registerTx = await wallet.writeContract(await withGasHeadroom(request));
  const receipt = await confirm(registerTx);

  // Read the id out of the event rather than trusting the simulation, which
  // predicted it against earlier state. This is the same reason the vault's
  // address is read back from the factory in Stage 5.
  const minted = await mintedIdFrom(receipt.blockNumber, agent.agentEvmAddress as Address);
  const confirmedId = minted ?? agentId;

  const uri = registrationFile({
    agentId: confirmedId,
    buyerAddress,
    appUrl: process.env.APP_URL ?? "https://cosmicgamesanctuary.com",
  });
  const { request: uriRequest } = await client.simulateContract({
    account,
    address: registry,
    abi: identityRegistryAbi,
    functionName: "setAgentURI",
    args: [confirmedId, uri],
    ...(await feeOverrides()),
  });
  const uriTx = await wallet.writeContract(await withGasHeadroom(uriRequest));
  await confirm(uriTx);

  logger.info(
    { agentId: agent.id, erc8004AgentId: confirmedId.toString(), registry, registerTx, uriTx },
    "agent registered on the ERC-8004 IdentityRegistry",
  );
  return { agentId: confirmedId, registerTx, uriTx };
}

/** The id minted to `owner` in this block, if the log is readable yet. */
async function mintedIdFrom(blockNumber: bigint, owner: Address): Promise<bigint | null> {
  try {
    const logs = await publicClient().getContractEvents({
      address: identityRegistryAddress(),
      abi: identityRegistryAbi,
      eventName: "Registered",
      args: { owner },
      fromBlock: blockNumber,
      toBlock: blockNumber,
      strict: true,
    });
    return logs.at(-1)?.args.agentId ?? null;
  } catch (err) {
    // A log that is not queryable yet is the documented lag, not a failure — the
    // simulated id is still the best answer available and it is almost always
    // right. Logged so a mismatch is traceable rather than silent.
    logger.warn({ err, blockNumber: blockNumber.toString() }, "could not read the Registered event; using the simulated agent id");
    return null;
  }
}

/** The registration file as the chain holds it, decoded. */
export async function readRegistration(agentId: bigint): Promise<Record<string, unknown> | null> {
  const uri = await publicClient().readContract({
    address: identityRegistryAddress(),
    abi: identityRegistryAbi,
    functionName: "tokenURI",
    args: [agentId],
  });
  const marker = "base64,";
  const at = uri.indexOf(marker);
  if (at === -1) return null;
  try {
    return JSON.parse(Buffer.from(uri.slice(at + marker.length), "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function readAgentWallet(agentId: bigint): Promise<Address> {
  return publicClient().readContract({
    address: identityRegistryAddress(),
    abi: identityRegistryAbi,
    functionName: "getAgentWallet",
    args: [agentId],
  });
}

export async function readMetadata(agentId: bigint, key: string): Promise<Hex> {
  return publicClient().readContract({
    address: identityRegistryAddress(),
    abi: identityRegistryAbi,
    functionName: "getMetadata",
    args: [agentId, key],
  });
}

/**
 * Write one of our own metadata keys, signed by the agent.
 *
 * Used for the spending ceiling, which changes whenever the buyer changes a
 * want — so unlike the funding principal it cannot ride along with the mint.
 *
 * `value` is raw bytes and the caller chooses the encoding, deliberately: this
 * function has no way to know whether it is being handed an address or a number,
 * and guessing is how the funding principal came to be stored as ASCII.
 */
export async function writeMetadata(
  agent: AgentWallet,
  agentId: bigint,
  key: string,
  value: Hex,
): Promise<Hex> {
  const account = await privyViemAccount(agent.agentWalletId, agent.agentEvmAddress as Address);
  const { request } = await publicClient().simulateContract({
    account,
    address: identityRegistryAddress(),
    abi: identityRegistryAbi,
    functionName: "setMetadata",
    args: [agentId, key, value],
    ...(await feeOverrides()),
  });
  const txHash = await clientFor(account).writeContract(await withGasHeadroom(request));
  await confirm(txHash);
  return txHash;
}
