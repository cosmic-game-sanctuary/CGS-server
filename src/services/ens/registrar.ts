import { decodeEventLog, encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { publicClient, walletClient, ensAccount } from "./client.js";
import { erc20Abi, ethRegistrarAbi, verifiableFactoryAbi, userRegistryInitAbi, permissionedRegistryAbi } from "./abis.js";
import { FULL_ADMIN_BITMAP, STUDIO_BITMAP } from "./roles.js";
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

// Per studio: mint "studio.cgs-sanctuary.eth" under the subregistry the
// platform owns. Grants a limited role set (STUDIO_BITMAP) — enough for the
// studio to point its own name somewhere, not enough to unregister or
// transfer it away from platform control.
export async function registerStudioSubname(
  subregistryAddress: Hex,
  label: string,
  ownerAddress: Hex,
): Promise<Hex> {
  const expiry = BigInt(Math.floor(Date.now() / 1000)) + ONE_YEAR;
  const hash = await walletClient.writeContract({
    address: subregistryAddress,
    abi: permissionedRegistryAbi,
    functionName: "register",
    args: [label, ownerAddress, "0x0000000000000000000000000000000000000000", env.ENS_RESOLVER as Hex, STUDIO_BITMAP, expiry],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
