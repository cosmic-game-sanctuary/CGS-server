/**
 * Proves the agent's identity is a real ERC-8004 registration, not a string we
 * invented, and that its spending mandate is published where it spends.
 *
 *   npx tsx scripts/arc-agent-identity-check.ts
 *
 * Registers a throwaway agent on the live registry at
 * `0x8004A818BFB912233c491871b3d84c89A494BD9e` — which we did not deploy and do
 * not control — and checks, from the chain:
 *
 *   registering mints an ERC-721 whose token id is the agent id
 *   the agent owns its own token, and `agentWallet` is its own address
 *   the registration file is readable with one eth_call, with no gateway
 *   the buyer is named on chain as the funding principal
 *   the spending ceiling is published, and refuses a purchase above it
 */
import { randomUUID } from "node:crypto";
import { formatUnits, getAddress, hexToBigInt, toHex, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config/env.js";
import {
  agentRegistryId,
  arcChain,
  confirm,
  feeOverrides,
  identityRegistryAddress,
  operator,
  publicClient,
  unitsToWei,
  walletClient,
} from "../src/services/arc/client.js";
import { privy } from "../src/services/privy/client.js";
import {
  FUNDING_PRINCIPAL_KEY,
  MAX_SPEND_KEY,
  readAgentWallet,
  readMetadata,
  readRegistration,
  registerAgentIdentity,
  writeMetadata,
} from "../src/services/agent/identity.js";
import { payGatedResource } from "../src/services/arc/x402/payer.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("this only runs against testnet");

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};
const client = publicClient();
const costs: { label: string; hash: string }[] = [];

console.log(`registry ${identityRegistryAddress()}`);
console.log(`agentRegistry id ${agentRegistryId()}\n`);

console.log("== the registry is somebody else's, and it is an ERC-721 ==");
const code = await client.getCode({ address: identityRegistryAddress() });
check("the registry has code at the per-chain singleton address", Boolean(code && code !== "0x"));
const regName = await client.readContract({
  address: identityRegistryAddress(),
  abi: [{ type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const,
  functionName: "name",
});
check("it identifies itself as an agent identity registry", regName === "AgentIdentity", regName);

console.log("\n== an agent wallet, funded enough to register itself ==");
const wallet = await privy.wallets().create({ chain_type: "ethereum" });
const agent = {
  id: randomUUID(),
  agentWalletId: wallet.id,
  agentEvmAddress: wallet.address,
};
console.log(`   agent wallet ${agent.agentEvmAddress}`);
check("a fresh agent wallet holds nothing", (await client.getBalance({ address: agent.agentEvmAddress as Address })) === 0n);

// 0.3 USDC: enough for two registration transactions, a metadata write, and the
// purchase attempt below.
const funding = unitsToWei(300_000n);
await confirm(
  await walletClient().sendTransaction({
    account: operator(),
    chain: arcChain(),
    to: agent.agentEvmAddress as Address,
    value: funding,
    ...(await feeOverrides()),
  }),
);
check("it is funded now", (await client.getBalance({ address: agent.agentEvmAddress as Address })) === funding);

console.log("\n== registering ==");
// Generated, never hand-typed: a shaped-but-invalid address fails viem's
// checksum check, which is a documented trap in this repo's gotchas table.
const buyer = privateKeyToAccount(generatePrivateKey()).address;
const reg = await registerAgentIdentity(agent, buyer);
costs.push({ label: "register (mint + metadata)", hash: reg.registerTx });
costs.push({ label: "write the registration file", hash: reg.uriTx });
console.log(`   agentId ${reg.agentId}`);
console.log(`   ${reg.registerTx}`);
check("registering returned an agent id", reg.agentId > 0n);

const owner = await client.readContract({
  address: identityRegistryAddress(),
  abi: [{ type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }] as const,
  functionName: "ownerOf",
  args: [reg.agentId],
});
check("the agent owns its own token", getAddress(owner) === getAddress(agent.agentEvmAddress as Address), owner);
check(
  "the reserved agentWallet is the agent's own address",
  getAddress(await readAgentWallet(reg.agentId)) === getAddress(agent.agentEvmAddress as Address),
);

console.log("\n== the registration file, read off the chain with no gateway ==");
const file = await readRegistration(reg.agentId);
check("the file is readable from tokenURI alone", file !== null);
check("it declares the spec's registration type", String(file?.type).includes("eip-8004#registration-v1"));
check("it names itself", file?.name === "cgs-wishlist-agent");
check("it declares x402 support, which is true", file?.x402Support === true);
check("it is marked active", file?.active === true);
const registrations = (file?.registrations ?? []) as { agentId: number; agentRegistry: string }[];
check("it names its own agent id", registrations[0]?.agentId === Number(reg.agentId), registrations[0]?.agentId);
check("and the registry it is registered on", registrations[0]?.agentRegistry === agentRegistryId());
check("it names the funding principal", String(file?.["cgs:fundingPrincipal"]).toLowerCase() === buyer.toLowerCase());

console.log("\n== the funding principal, also as on-chain metadata ==");
const principal = await readMetadata(reg.agentId, FUNDING_PRINCIPAL_KEY);
check(
  "the buyer is stored as a real 20-byte address, not as text",
  principal.length === 42 && getAddress(principal) === getAddress(buyer),
  principal,
);

console.log("\n== the spending ceiling, published where the money moves ==");
const CEILING = 150_000n; // 0.15 USDC
const ceilingTx = await writeMetadata(agent, reg.agentId, MAX_SPEND_KEY, toHex(CEILING, { size: 32 }));
costs.push({ label: "publish the spending ceiling", hash: ceilingTx });
const readBack = await readMetadata(reg.agentId, MAX_SPEND_KEY);
check("the ceiling is stored as a 32-byte word", readBack.length === 66, readBack);
check("and reads back as the number that was written", hexToBigInt(readBack) === CEILING, hexToBigInt(readBack));
check("and it is on Arc, the same chain the agent spends on", arcChain().id === 5042002);

console.log("\n== the ceiling refuses a purchase above it, before signing ==");
// Pointed at a route that would quote more than the ceiling. The refusal has to
// happen without a signature existing, which is what makes it a real cap rather
// than a rule our own code chooses to follow.
let refused = false;
let refusedCode = "";
const balanceBefore = await client.getBalance({ address: agent.agentEvmAddress as Address });
try {
  await payGatedResource(`http://127.0.0.1:${env.PORT}/api/agent/verdict`, {
    address: agent.agentEvmAddress as Address,
    signTypedData: () => {
      // Reaching here means the cap did not stop it. Fail loudly rather than
      // sign something the mandate forbids.
      throw new Error("SIGNED_ABOVE_CEILING");
    },
  } as never, { maxUnits: 1n });
} catch (err) {
  const e = err as { code?: string; message?: string };
  refusedCode = e.code ?? "";
  refused = e.message !== "SIGNED_ABOVE_CEILING";
}
check("a payment above the ceiling is refused", refused, refusedCode || "it signed anyway");
check("and refused by name, so a caller can act on it", refusedCode === "ABOVE_MANDATE", refusedCode);
check("nothing left the agent's wallet", (await client.getBalance({ address: agent.agentEvmAddress as Address })) === balanceBefore);

console.log("\n== measured cost, paid by the agent itself ==");
let total = 0n;
for (const { label, hash } of costs) {
  const r = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
  const cost = r.gasUsed * r.effectiveGasPrice;
  total += cost;
  console.log(`   ${label.padEnd(30)} ${formatUnits(cost, 18).slice(0, 10)} USDC`);
}
console.log(`   ${"—".repeat(30)} ${formatUnits(total, 18).slice(0, 10)} USDC`);

console.log(`\nagent token ${reg.agentId} at ${identityRegistryAddress()}`);
console.log(`explorer: https://explorer.testnet.arc.io/token/${identityRegistryAddress()}/instance/${reg.agentId}`);
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
