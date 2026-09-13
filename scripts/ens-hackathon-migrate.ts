/**
 * Rebuild our whole ENS presence on the **ETHOnline hackathon deployment**.
 *
 * **Why this exists.** Everything was originally built against the public
 * ENSv2 Sepolia beta, whose addresses are the ones on the production docs. ENS
 * runs a separate, dedicated deployment for the hackathon with its own
 * registry, registrar, factory and resolver implementation, its own app and
 * its own explorer — and names on one are invisible to the other. Nothing
 * migrates between them: the parent name, the subregistry, the resolver and
 * every subname have to be created again from scratch.
 *
 * The resolver's interface changed with it. Setters take a DNS-encoded name
 * rather than a namehash, addresses are ENSIP-9 multichain byte strings, and
 * `initialize` takes role grants plus a multicall. That is handled in
 * `services/ens/`; this script only sequences the work.
 *
 * **Run order matters and each step depends on the last:**
 *   1. mint MockUSDC and register the parent name (a 60s commit wait)
 *   2. deploy our own subregistry, attach it to the parent name
 *   3. deploy our own Permissioned Resolver
 *   4. re-register every studio and agent subname under the new subregistry
 *   5. write each name's records through the new resolver
 *
 *   npm run ens:migrate            # dry run, prints the plan
 *   npm run ens:migrate -- --yes   # actually do it
 */
import { isNotNull, eq } from "drizzle-orm";
import { encodeAbiParameters, encodeFunctionData, keccak256, namehash, stringToHex, toHex, parseAbi } from "viem";
import { db } from "../src/db/client.js";
import { studios, users, wishlistAgents, wishlistItems } from "../src/db/schema.js";
import { env } from "../src/config/env.js";
import { toDisplayAmount } from "../src/lib/display.js";
import { publicClient, walletClient, ensAccount } from "../src/services/ens/client.js";
import { erc20Abi, ethRegistrarAbi, verifiableFactoryAbi, userRegistryInitAbi, permissionedRegistryAbi, permissionedResolverAbi } from "../src/services/ens/abis.js";
import { STUDIO_BITMAP, AGENT_BITMAP, ALL_ROLES } from "../src/services/ens/roles.js";
import { setSubnameAddress, setSubnameText, readSubnameAddress, readSubnameText, resolveSubnameOwner } from "../src/services/ens/registrar.js";
import { decodeEventLog } from "viem";

const argv = process.argv.slice(2);
const write = argv.includes("--yes");
function flag(name: string): `0x${string}` | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] as `0x${string}`) : null;
}
// The factory salts are deterministic, so a second deploy with the same salt
// reverts on the CREATE2 collision rather than returning the existing proxy.
// Pass these to resume a run that got past the deploys and failed later.
const existingSubregistry = flag("subregistry");
const existingResolver = flag("resolver");
const ONE_YEAR = 365n * 24n * 60n * 60n;
const NO_REFERRER = `0x${"0".repeat(64)}` as `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

function say(step: string, detail = "") {
  console.log(`${write ? "" : "[dry] "}${step}${detail ? "  " + detail : ""}`);
}

async function deployProxy(impl: `0x${string}`, salt: bigint, initData: `0x${string}`) {
  const hash = await walletClient.writeContract({
    address: env.ENS_VERIFIABLE_FACTORY as `0x${string}`,
    abi: verifiableFactoryAbi,
    functionName: "deployProxy",
    args: [impl, salt, initData],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  for (const log of receipt.logs) {
    try {
      const d = decodeEventLog({ abi: verifiableFactoryAbi, ...log });
      if (d.eventName === "ProxyDeployed") return d.args.proxyAddress as `0x${string}`;
    } catch { continue; }
  }
  throw new Error(`no ProxyDeployed event in ${receipt.transactionHash}`);
}

async function main() {
  const label = env.ENS_PARENT_NAME;
  console.log(`operator ${ensAccount.address}`);
  console.log(`parent   ${label}.eth on the hackathon deployment\n`);

  const named = {
    studios: await db.query.studios.findMany({
      where: isNotNull(studios.ensSubname),
      columns: { id: true, name: true, ensSubname: true, ownerUserId: true },
    }),
    agents: await db.query.wishlistAgents.findMany({
      where: isNotNull(wishlistAgents.ensLabel),
      columns: { id: true, ensLabel: true, agentEvmAddress: true, agentAccountId: true, mode: true, buyerUserId: true },
    }),
  };
  say(`${named.studios.length} studio names and ${named.agents.length} agent names to re-create`);

  if (!write) {
    console.log("\nDry run. Re-run with --yes to apply.\n");
    for (const s of named.studios) console.log(`  studio ${s.ensSubname}`);
    for (const a of named.agents) console.log(`  agent  ${a.ensLabel}`);
    return;
  }

  // ---- 1. the parent name -------------------------------------------------
  // Resumable on purpose: the parent registration is a 60-second commit wait
  // and ~8 MockUSDC, and a later step failing must not mean paying for it
  // twice. If the name is already ours, skip straight to the deployments.
  const available = await publicClient.readContract({
    address: env.ENS_ETH_REGISTRAR as `0x${string}`, abi: ethRegistrarAbi,
    functionName: "isAvailable", args: [label],
  });
  if (!available) {
    const parentOwner = await publicClient.readContract({
      address: env.ENS_ETH_REGISTRY as `0x${string}`,
      abi: parseAbi(["function ownerOf(uint256) view returns (address)"]),
      functionName: "ownerOf", args: [BigInt(keccak256(toHex(label))) & ~0xffffffffn],
    }).catch(() => ZERO);
    if (parentOwner.toLowerCase() !== ensAccount.address.toLowerCase()) {
      throw new Error(`"${label}" is taken on the hackathon deployment by ${parentOwner}`);
    }
    say("parent name already registered to us — skipping registration");
  }
  if (available) {

  const [base, premium] = await publicClient.readContract({
    address: env.ENS_ETH_REGISTRAR as `0x${string}`, abi: ethRegistrarAbi,
    functionName: "getRegisterPrice", args: [label, ONE_YEAR, env.ENS_MOCK_USDC as `0x${string}`],
  });
  const price = base + premium;
  say("minting MockUSDC", `${Number(price) / 1e6} needed`);
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      address: env.ENS_MOCK_USDC as `0x${string}`, abi: erc20Abi,
      functionName: "mint", args: [ensAccount.address, price * 3n],
    }),
  });
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      address: env.ENS_MOCK_USDC as `0x${string}`, abi: erc20Abi,
      functionName: "approve", args: [env.ENS_ETH_REGISTRAR as `0x${string}`, price * 3n],
    }),
  });

  const secret = keccak256(toHex(`cgs:${label}:${Date.now()}`));
  const commitment = await publicClient.readContract({
    address: env.ENS_ETH_REGISTRAR as `0x${string}`, abi: ethRegistrarAbi,
    functionName: "makeCommitment",
    args: [label, ensAccount.address, secret, ZERO, ZERO, ONE_YEAR, NO_REFERRER],
  });
  say("commit");
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      address: env.ENS_ETH_REGISTRAR as `0x${string}`, abi: ethRegistrarAbi,
      functionName: "commit", args: [commitment],
    }),
  });
  say("waiting out MIN_COMMITMENT_AGE", "75s");
  await new Promise((r) => setTimeout(r, 75_000));

  say("register", `${label}.eth`);
  const regReceipt = await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      address: env.ENS_ETH_REGISTRAR as `0x${string}`, abi: ethRegistrarAbi,
      functionName: "register",
      args: [label, ensAccount.address, secret, ZERO, ZERO, ONE_YEAR, env.ENS_MOCK_USDC as `0x${string}`, NO_REFERRER],
    }),
  });
  if (regReceipt.status !== "success") throw new Error("register reverted");
  }

  // ---- 2. our own subregistry --------------------------------------------
  say(existingSubregistry ? "reusing subregistry" : "deploying subregistry");
  const subregistry = existingSubregistry ?? await deployProxy(
    env.ENS_USER_REGISTRY_IMPL as `0x${string}`,
    // ENS's documented scheme: keccak256("UserRegistry", namehash, version)
    BigInt(keccak256(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
      [keccak256(stringToHex("UserRegistry")), namehash(`${label}.eth`), 0n],
    ))),
    encodeFunctionData({ abi: userRegistryInitAbi, functionName: "initialize", args: [[{ account: ensAccount.address, roleBitmap: ALL_ROLES }]] }),
  );
  say("  subregistry", subregistry);

  // attach it to the parent name on the ETH registry
  const ethRegistry = env.ENS_ROOT_REGISTRY as `0x${string}`;
  const parentTokenId = BigInt(keccak256(toHex(label))) & ~0xffffffffn;
  if (!existingSubregistry) {
  say("attaching subregistry to the parent name");
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      address: env.ENS_ETH_REGISTRY as `0x${string}`,
      abi: parseAbi(["function setSubregistry(uint256 tokenId, address subregistry)"]),
      functionName: "setSubregistry", args: [parentTokenId, subregistry],
    }),
  });
  }

  // ---- 3. our own resolver ------------------------------------------------
  say(existingResolver ? "reusing resolver" : "deploying Permissioned Resolver");
  const resolver = existingResolver ?? await deployProxy(
    env.ENS_PERMISSIONED_RESOLVER_IMPL as `0x${string}`,
    // ENS's documented scheme: keccak256("OwnedResolver", owner, version)
    BigInt(keccak256(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [keccak256(stringToHex("OwnedResolver")), ensAccount.address, 0n],
    ))),
    encodeFunctionData({
      abi: permissionedResolverAbi, functionName: "initialize",
      args: [[{ account: ensAccount.address, roleBitmap: ALL_ROLES }], []],
    }),
  );
  say("  resolver", resolver);

  console.log(`\n>>> ENS_SUBREGISTRY_ADDRESS=${subregistry}`);
  console.log(`>>> ENS_RESOLVER=${resolver}\n`);

  // ---- 4 + 5. every subname, then its records -----------------------------
  const expiry = BigInt(Math.floor(Date.now() / 1000)) + ONE_YEAR;
  async function registerSub(l: string, owner: `0x${string}`, bitmap: bigint) {
    const already = await resolveSubnameOwner(subregistry, l);
    if (already) { say("  already registered", `${l} -> ${already}`); return; }
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        address: subregistry, abi: permissionedRegistryAbi, functionName: "register",
        args: [l, owner, ZERO, resolver, bitmap, expiry],
      }),
    });
  }

  for (const s of named.studios) {
    const l = s.ensSubname!;
    // studios reference their owner by user id; the wallet is on users
    const ownerRow = await db.query.users.findFirst({
      where: eq(users.id, s.ownerUserId), columns: { evmAddress: true },
    });
    const ownerAddr = ownerRow?.evmAddress;
    const owner = (ownerAddr && ownerAddr !== ZERO ? ownerAddr : ensAccount.address) as `0x${string}`;
    say("studio", l);
    await registerSub(l, owner, STUDIO_BITMAP);
    await setSubnameAddress(resolver, l, owner);
    await setSubnameText(resolver, l, "cgs:role", "studio");
    await setSubnameText(resolver, l, "cgs:name", s.name);
  }

  for (const a of named.agents) {
    const l = a.ensLabel!;
    const owner = a.agentEvmAddress as `0x${string}`;
    const wants = await db.query.wishlistItems.findMany({
      where: eq(wishlistItems.userId, a.buyerUserId), columns: { agentMaxUnits: true },
    });
    const ceiling = wants.reduce((m, w) => (w.agentMaxUnits && w.agentMaxUnits > m ? w.agentMaxUnits : m), 0);
    say("agent", `${l} (max ${toDisplayAmount(ceiling, env.X402_ASSET)}, ${a.mode})`);
    // AGENT_BITMAP is ROLE_RENEW only — no ROLE_SET_RESOLVER, so the agent
    // cannot repoint its name away from the resolver holding its mandate.
    await registerSub(l, owner, AGENT_BITMAP);
    await setSubnameAddress(resolver, l, owner);
    await setSubnameText(resolver, l, "cgs:role", "agent");
    await setSubnameText(resolver, l, "cgs:account", a.agentAccountId ?? "");
    await setSubnameText(resolver, l, "cgs:maxSpend", String(toDisplayAmount(ceiling, env.X402_ASSET)));
    await setSubnameText(resolver, l, "cgs:mode", a.mode);
  }

  // ---- read it all back, so the run proves itself -------------------------
  console.log("\nreading back through resolve():");
  for (const l of [...named.studios.map((s) => s.ensSubname!), ...named.agents.map((a) => a.ensLabel!)]) {
    const owner = await resolveSubnameOwner(subregistry, l);
    const addr = await readSubnameAddress(resolver, l);
    const role = await readSubnameText(resolver, l, "cgs:role");
    const max = await readSubnameText(resolver, l, "cgs:maxSpend");
    console.log(`  ${l.padEnd(16)} owner=${owner ?? "none"} addr=${addr ?? "none"} role=${role || "-"} max=${max || "-"}`);
  }
  console.log("\nPut the two addresses above into .env (and Render) before restarting the server.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
