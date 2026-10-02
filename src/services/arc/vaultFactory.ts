import { getAddress, type Address, type Hex } from "viem";
import { vaultFactoryAbi } from "./abis.js";
import {
  confirm,
  feeOverrides,
  operator,
  platformPayoutAddress,
  publicClient,
  vaultFactoryAddress,
  walletClient,
  withGasHeadroom,
} from "./client.js";
import { env } from "../../config/env.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

export type VaultRecipient = { address: Address; bps: number };

/**
 * Creating the contract that holds a game's money.
 *
 * Called once, at publish. After this the split is beyond anyone's reach —
 * ours included — which is the point: "splits are immutable once a game is
 * published" stops being a policy we promise to honour and becomes a fact
 * about a deployed contract.
 */

/** Zero address when the game has no vault yet. */
export async function existingVault(gameId: Hex): Promise<Address | null> {
  const vault = await publicClient().readContract({
    address: vaultFactoryAddress(),
    abi: vaultFactoryAbi,
    functionName: "vaultOf",
    args: [gameId],
  });
  return vault === ZERO ? null : vault;
}

/**
 * The studio's shares as whole percents, converted to basis points with the
 * platform's cut taken out of the whole.
 *
 * A split stored as "60/40 between two developers" means 60/40 of what the
 * studio keeps, not of the sale — so the platform's 5% comes off first and the
 * rest is divided in those proportions. Any remainder from the division is
 * given to the largest share, because the contract requires the basis points to
 * total exactly 10,000 and one unit missing would make the publish revert.
 */
export function toBasisPoints(
  recipients: { wallet: string; pct: number }[],
  platformBps = env.PLATFORM_FEE_BPS,
): VaultRecipient[] {
  if (recipients.length === 0) throw new Error("a game needs at least one payee");

  const studioBps = 10_000 - platformBps;
  const out = recipients.map((r) => ({
    address: getAddress(r.wallet),
    bps: Math.floor((studioBps * r.pct) / 100),
  }));

  const shortfall = studioBps - out.reduce((sum, r) => sum + r.bps, 0);
  if (shortfall !== 0) {
    const largest = out.reduce((a, b) => (b.bps > a.bps ? b : a));
    largest.bps += shortfall;
  }
  return out;
}

export type DeployedVault = { vault: Address; txHash: Hex | null; alreadyExisted: boolean };

/**
 * Deploy the game's vault, or hand back the one it already has.
 *
 * The second case is not a failure and not rare: publishing is this deploy plus
 * a registry write, so a publish that died between them is retried, and the
 * retry must find the same vault rather than make a second one. The factory
 * decides that, not this function — see VaultFactory.sol.
 */
export async function deployVault(gameId: Hex, recipients: VaultRecipient[]): Promise<DeployedVault> {
  const existing = await existingVault(gameId);
  if (existing) return { vault: existing, txHash: null, alreadyExisted: true };

  const platform = platformPayoutAddress();
  const platformBps = env.PLATFORM_FEE_BPS;

  // Caught here rather than as a bare revert from the constructor, because at
  // this point the developer is waiting on a publish and "DuplicateRecipient"
  // tells them nothing about which address collided.
  const duplicate = recipients.find((r) => r.address.toLowerCase() === platform.toLowerCase());
  if (duplicate) {
    throw new Error(
      `${duplicate.address} is both a payee on this game and the platform's own payout address. ` +
        `The vault rejects the same address twice, so set ARC_PLATFORM_PAYOUT to something separate.`,
    );
  }

  const args = [
    gameId,
    recipients.map((r) => r.address),
    recipients.map((r) => r.bps),
    platform,
    platformBps,
  ] as const;

  // Simulated first, which also returns the address the deploy will produce —
  // so a bad split fails by the contract's own error name before any gas is
  // spent, and the vault address is known before the write is sent.
  const { request, result } = await publicClient().simulateContract({
    account: operator(),
    address: vaultFactoryAddress(),
    abi: vaultFactoryAbi,
    functionName: "deploy",
    args,
    ...(await feeOverrides()),
  });

  const txHash = await walletClient().writeContract(await withGasHeadroom(request));
  await confirm(txHash);

  // Read back rather than trusting the simulation: the simulated address is
  // what *would* have happened against the state at simulation time, and this
  // is the address the chain actually recorded.
  const deployed = await existingVault(gameId);
  if (!deployed) throw new Error(`vault deploy for ${gameId} confirmed in ${txHash} but the factory has no record of it`);
  if (deployed !== result) {
    throw new Error(`vault deploy for ${gameId} produced ${deployed}, but the simulation predicted ${result}`);
  }

  return { vault: deployed, txHash, alreadyExisted: false };
}
