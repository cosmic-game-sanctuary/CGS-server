import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  namehash,
  stringToHex,
  toBytes,
  toHex,
  type Hex,
} from "viem";
import { publicClient, walletClient, ensAccount } from "./client.js";
import {
  erc20Abi,
  ethRegistrarAbi,
  verifiableFactoryAbi,
  userRegistryInitAbi,
  permissionedRegistryAbi,
  permissionedResolverAbi,
  registrySetResolverAbi,
} from "./abis.js";
import { FULL_ADMIN_BITMAP, STUDIO_BITMAP, AGENT_BITMAP, ALL_RESOLVER_ROLES } from "./roles.js";
import { env } from "../../config/env.js";

const ONE_YEAR = 365n * 24n * 60n * 60n;
const NO_REFERRER = `0x${"0".repeat(64)}` as Hex;

export async function isNameAvailable(label: string): Promise<boolean> {
  return publicClient.readContract({
    address: env.ENS_ETH_REGISTRAR as Hex,
    abi: ethRegistrarAbi,
    functionName: "isAvailable",
    args: [label],
  });
}

// self-mintable, verified with a real eth_call before ever being trusted —
// see docs/stage-7.md. Only the operator ever calls this; there's no user
// flow that touches a mock token.
export async function mintTestUsdc(to: Hex, amount: bigint) {
  const hash = await walletClient.writeContract({
    address: env.ENS_MOCK_USDC as Hex,
    abi: erc20Abi,
    functionName: "mint",
    args: [to, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// One-time: a subregistry we own outright, deployed as a UUPS proxy via
// VerifiableFactory. Its address becomes the `subregistry` param on the
// parent name's registration — that's what makes it the contract that
// controls every studio subname minted underneath.
export async function deploySubregistry(): Promise<Hex> {
  const initData = encodeFunctionData({
    abi: userRegistryInitAbi,
    functionName: "initialize",
    args: [ensAccount.address, FULL_ADMIN_BITMAP],
  });

  const salt = BigInt(keccak256(toHex(`cgs-subregistry:${env.ENS_PARENT_NAME}`)));

  const hash = await walletClient.writeContract({
    address: env.ENS_VERIFIABLE_FACTORY as Hex,
    abi: verifiableFactoryAbi,
    functionName: "deployProxy",
    args: [env.ENS_USER_REGISTRY_IMPL as Hex, salt, initData],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // deployProxy's return value isn't recoverable from a receipt (only logs
  // are) — the factory has no address-prediction view function either
  // (confirmed against its real ABI), so the deployed address comes from
  // its own ProxyDeployed event.
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: verifiableFactoryAbi, ...log });
      if (decoded.eventName === "ProxyDeployed") return decoded.args.proxyAddress;
    } catch {
      continue; // a log from a different contract/event in the same tx
    }
  }
  throw new Error(`deployProxy succeeded (tx ${receipt.transactionHash}) but no ProxyDeployed log was found`);
}

// The full parent-name registration: commit, wait out MIN_COMMITMENT_AGE (a
// real 60s on this deployment — checked live, not assumed), then register.
// Runs once, ever, as a setup script — a blocking wait is fine here, this is
// not a request path.
export async function registerParentName(subregistryAddress: Hex): Promise<{ tokenId: bigint; txHash: Hex }> {
  const label = env.ENS_PARENT_NAME;
  const owner = ensAccount.address;
  const secret = keccak256(toHex(`cgs:${label}:${Date.now()}`));
  const resolver = env.ENS_RESOLVER as Hex;
  const paymentToken = env.ENS_MOCK_USDC as Hex;

  const available = await isNameAvailable(label);
  if (!available) throw new Error(`"${label}" is not available to register`);

  const [base, premium] = await publicClient.readContract({
    address: env.ENS_ETH_REGISTRAR as Hex,
    abi: ethRegistrarAbi,
    functionName: "getRegisterPrice",
    args: [label, ONE_YEAR, paymentToken],
  });
  const totalPrice = base + premium;

  await mintTestUsdc(owner, totalPrice * 2n); // headroom for a second attempt if this one needs redoing
  await walletClient.writeContract({
    address: paymentToken,
    abi: erc20Abi,
    functionName: "approve",
    args: [env.ENS_ETH_REGISTRAR as Hex, totalPrice * 2n],
  });

  const commitment = await publicClient.readContract({
    address: env.ENS_ETH_REGISTRAR as Hex,
    abi: ethRegistrarAbi,
    functionName: "makeCommitment",
    args: [label, owner, secret, subregistryAddress, resolver, ONE_YEAR, NO_REFERRER],
  });

  const commitHash = await walletClient.writeContract({
    address: env.ENS_ETH_REGISTRAR as Hex,
    abi: ethRegistrarAbi,
    functionName: "commit",
    args: [commitment],
  });
  await publicClient.waitForTransactionReceipt({ hash: commitHash });

  // MIN_COMMITMENT_AGE is 60s on this deployment, read live, not assumed —
  // wait a little past it rather than racing the exact boundary.
  await new Promise((r) => setTimeout(r, 75_000));

  const registerHash = await walletClient.writeContract({
    address: env.ENS_ETH_REGISTRAR as Hex,
    abi: ethRegistrarAbi,
    functionName: "register",
    args: [label, owner, secret, subregistryAddress, resolver, ONE_YEAR, paymentToken, NO_REFERRER],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: registerHash });
  if (receipt.status !== "success") throw new Error(`register() reverted: ${registerHash}`);

  return { tokenId: 0n, txHash: registerHash }; // tokenId parsed from logs by the caller if needed
}

/**
 * The token id the registry files a label under.
 *
 * `keccak256(label)` with the **low 32 bits cleared** — not the bare hash, and
 * not a namehash. Those low bits are the registry's own version counter, so a
 * name re-registered after expiry keeps a stable id while the counter moves.
 * Derived by testing candidates against a name we knew was registered until
 * `ownerOf` returned its real owner, rather than assumed from v1 conventions
 * (a bare `keccak256(label)` returns the zero address, which reads exactly
 * like "this name does not exist" and sent this investigation sideways once).
 */
export function subnameTokenId(label: string): bigint {
  return BigInt(keccak256(toBytes(label))) & ~0xffffffffn;
}

/**
 * Resolve a subname to the address that owns it, on chain.
 *
 * **This is the real resolution path for an ENSv2 subname, and it is
 * deliberately not a v1 resolver call.** In v2 a name's subnames live in the
 * registry that issued them, so the registry is the authority on who holds
 * one. Asking it is a live `eth_call` against Sepolia every time — nothing is
 * cached and nothing is read from our own database, which is the whole point:
 * `ens_subname` in Postgres is a convenience, this is the fact.
 *
 * Returns null for a label nobody holds, so an unregistered name and a
 * registered one are distinguishable rather than both reading as "no address".
 */
export async function resolveSubnameOwner(
  subregistryAddress: Hex,
  label: string,
): Promise<Hex | null> {
  const owner = await publicClient.readContract({
    address: subregistryAddress,
    abi: permissionedRegistryAbi,
    functionName: "ownerOf",
    args: [subnameTokenId(label)],
  });
  return owner === "0x0000000000000000000000000000000000000000" ? null : owner;
}

// Real availability, not a guess at a view function that may not exist: a
// subname registration is simulated (eth_call, no tx, no gas spent) exactly
// as it would actually be sent. If the simulation reverts — most likely
// because the label is already registered — the label isn't available.
export async function isSubnameAvailable(subregistryAddress: Hex, label: string): Promise<boolean> {
  const expiry = BigInt(Math.floor(Date.now() / 1000)) + ONE_YEAR;
  try {
    await publicClient.simulateContract({
      address: subregistryAddress,
      abi: permissionedRegistryAbi,
      functionName: "register",
      args: [label, ensAccount.address, "0x0000000000000000000000000000000000000000", env.ENS_RESOLVER as Hex, STUDIO_BITMAP, expiry],
      account: ensAccount,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Deploy a Permissioned Resolver we own, through ENS's own VerifiableFactory.
 *
 * **Why this exists.** The resolver a name points at decides who may write its
 * records. ENSv2's model is one resolver instance per account, deployed as a
 * UUPS proxy — so owning the resolver is what makes the records ours to set.
 * Pointing names at a shared resolver instance nobody granted us roles on
 * leaves every `setAddr`/`setText` reverting, which is exactly the state the
 * names were in before this: registered, resolving to nothing.
 *
 * Salt matches ENS's own documented derivation — `keccak256("OwnedResolver",
 * owner, version)` — so the address is deterministic and predictable from the
 * operator address alone.
 *
 * One-time setup, same as `deploySubregistry`.
 */
export async function deployResolver(version = 0n): Promise<Hex> {
  const salt = BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
        [keccak256(stringToHex("OwnedResolver")), ensAccount.address, version],
      ),
    ),
  );

  const initData = encodeFunctionData({
    abi: permissionedResolverAbi,
    functionName: "initialize",
    // The **resolver's** role set, not the registry's — see
    // roles.ts#ALL_RESOLVER_ROLES for why that distinction bit once already.
    // Every role to the operator, because this one resolver serves every name
    // we issue. EAC still allows delegating a single record key later without
    // handing over the rest.
    args: [ensAccount.address, ALL_RESOLVER_ROLES, []],
  });

  const hash = await walletClient.writeContract({
    address: env.ENS_VERIFIABLE_FACTORY as Hex,
    abi: verifiableFactoryAbi,
    functionName: "deployProxy",
    args: [env.ENS_PERMISSIONED_RESOLVER_IMPL as Hex, salt, initData],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: verifiableFactoryAbi, ...log });
      if (decoded.eventName === "ProxyDeployed") return decoded.args.proxyAddress;
    } catch {
      continue;
    }
  }
  throw new Error(`deployProxy succeeded (tx ${receipt.transactionHash}) but no ProxyDeployed log was found`);
}

/** The namehash a resolver keys its records on. */
export function subnameNode(label: string): Hex {
  return namehash(`${label}.${env.ENS_PARENT_NAME}.eth`);
}

/**
 * Point an already-issued subname at a different resolver.
 *
 * Needed because names registered before we ran our own resolver are aimed at
 * one we cannot write to. Repointing is cheaper and less destructive than
 * re-registering: the name, its owner and its expiry are untouched.
 */
export async function setSubnameResolver(
  subregistryAddress: Hex,
  label: string,
  resolverAddress: Hex,
): Promise<Hex> {
  const hash = await walletClient.writeContract({
    address: subregistryAddress,
    abi: registrySetResolverAbi,
    functionName: "setResolver",
    args: [subnameTokenId(label), resolverAddress],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Write the address a name resolves to.
 *
 * For an agent this is the agent's **own** wallet rather than the buyer's, so
 * an autonomous spender resolves to the account that actually holds and spends
 * the money. That separation is the entire reason an agent has a name.
 */
export async function setSubnameAddress(
  resolverAddress: Hex,
  label: string,
  address: Hex,
): Promise<Hex> {
  const hash = await walletClient.writeContract({
    address: resolverAddress,
    abi: permissionedResolverAbi,
    functionName: "setAddr",
    args: [subnameNode(label), address],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Write one text record. Keys are namespaced `cgs:` so they never collide
 *  with ENS's own conventional keys (avatar, url, com.twitter…). */
export async function setSubnameText(
  resolverAddress: Hex,
  label: string,
  key: string,
  value: string,
): Promise<Hex> {
  const hash = await walletClient.writeContract({
    address: resolverAddress,
    abi: permissionedResolverAbi,
    functionName: "setText",
    args: [subnameNode(label), key, value],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Read an address record straight off the resolver. */
export async function readSubnameAddress(resolverAddress: Hex, label: string): Promise<Hex | null> {
  const addr = await publicClient.readContract({
    address: resolverAddress,
    abi: permissionedResolverAbi,
    functionName: "addr",
    args: [subnameNode(label)],
  });
  return addr === "0x0000000000000000000000000000000000000000" ? null : addr;
}

/** Read one text record straight off the resolver. */
export async function readSubnameText(
  resolverAddress: Hex,
  label: string,
  key: string,
): Promise<string> {
  return publicClient.readContract({
    address: resolverAddress,
    abi: permissionedResolverAbi,
    functionName: "text",
    args: [subnameNode(label), key],
  });
}

// Shared by studios and agents: mint// Shared by studios and agents: mint "<label>.cgs-sanctuary.eth" under the
// subregistry the platform owns. `bitmap` is the only thing that differs
// between them and both grant the same limited scope today — enough for the
// owner to point their own name somewhere, not enough to unregister or
// transfer it away from platform control. One flat namespace, so a studio and
// an agent compete for the same label and `isSubnameAvailable` catches either.
async function registerSubname(
  subregistryAddress: Hex,
  label: string,
  ownerAddress: Hex,
  bitmap: bigint,
): Promise<Hex> {
  const expiry = BigInt(Math.floor(Date.now() / 1000)) + ONE_YEAR;
  const hash = await walletClient.writeContract({
    address: subregistryAddress,
    abi: permissionedRegistryAbi,
    functionName: "register",
    args: [label, ownerAddress, "0x0000000000000000000000000000000000000000", env.ENS_RESOLVER as Hex, bitmap, expiry],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export function registerStudioSubname(subregistryAddress: Hex, label: string, ownerAddress: Hex): Promise<Hex> {
  return registerSubname(subregistryAddress, label, ownerAddress, STUDIO_BITMAP);
}

// Optional, at the buyer's choice: a name for their agent rather than a raw
// EVM address. See db/schema.ts#wishlistAgents.ensLabel.
export function registerAgentSubname(subregistryAddress: Hex, label: string, ownerAddress: Hex): Promise<Hex> {
  return registerSubname(subregistryAddress, label, ownerAddress, AGENT_BITMAP);
}
