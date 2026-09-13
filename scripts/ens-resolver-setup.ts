/**
 * Deploy a Permissioned Resolver we own, repoint every existing name at it,
 * and write the records that make those names actually resolve.
 *
 * **The problem this fixes.** Subnames were registered against a resolver
 * instance nobody had granted us roles on, so every record write reverted and
 * every name resolved to `0x0`. The names were real; what they pointed at was
 * nothing. ENSv2's model is one resolver per account, deployed as a UUPS proxy
 * through the VerifiableFactory — owning the resolver is what makes the
 * records yours to set.
 *
 * **What it writes.** An address record for every studio and agent, plus, for
 * agents, their spending mandate as text records:
 *
 *   cgs:role        agent | studio
 *   cgs:account     the Hedera account it spends from
 *   cgs:maxSpend    the ceiling, in the settlement asset
 *   cgs:mode        autonomous | ask_first
 *   cgs:owner       the account that funds it
 *
 * An agent's authority stops being a row in our database and becomes something
 * anyone can read off Sepolia without asking us. The identity was already
 * public; this makes the *permission* public too.
 *
 *   npm run ens:setup            # dry run, shows what it would do
 *   npm run ens:setup -- --yes   # deploy, repoint and write
 *   npm run ens:setup -- --yes --resolver 0x...   # reuse an existing deploy
 */
import { eq, isNotNull } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { studios, wishlistAgents, wishlistItems } from "../src/db/schema.js";
import { env } from "../src/config/env.js";
import { toDisplayAmount } from "../src/lib/display.js";
import {
  deployResolver,
  setSubnameResolver,
  setSubnameAddress,
  setSubnameText,
  readSubnameAddress,
  readSubnameText,
  resolveSubnameOwner,
} from "../src/services/ens/registrar.js";

const argv = process.argv.slice(2);
const write = argv.includes("--yes");
const resolverFlag = argv.indexOf("--resolver");
const versionFlag = argv.indexOf("--version");
const deployVersion = versionFlag >= 0 ? BigInt(argv[versionFlag + 1]!) : 0n;
const existingResolver = resolverFlag >= 0 ? (argv[resolverFlag + 1] as `0x${string}`) : null;

const registry = env.ENS_SUBREGISTRY_ADDRESS as `0x${string}`;

async function main() {
  const named = {
    studios: await db.query.studios.findMany({
      where: isNotNull(studios.ensSubname),
      columns: { id: true, name: true, ensSubname: true },
    }),
    agents: await db.query.wishlistAgents.findMany({
      where: isNotNull(wishlistAgents.ensLabel),
      columns: {
        id: true,
        ensLabel: true,
        agentEvmAddress: true,
        agentAccountId: true,
        mode: true,
        buyerUserId: true,
      },
    }),
  };

  console.log(`${named.studios.length} named studios, ${named.agents.length} named agents`);
  if (!write) {
    console.log("\nDry run. Nothing will be written. Re-run with --yes to apply.\n");
  }

  // 1. A resolver of our own.
  let resolver = existingResolver;
  if (!resolver) {
    if (!write) {
      console.log("would deploy a Permissioned Resolver proxy via VerifiableFactory");
      resolver = "0x0000000000000000000000000000000000000000";
    } else {
      console.log("deploying Permissioned Resolver proxy…");
      resolver = await deployResolver(deployVersion);
      console.log(`  deployed at ${resolver}`);
      console.log(`  >>> put this in .env as ENS_RESOLVER=${resolver}`);
    }
  } else {
    console.log(`reusing resolver ${resolver}`);
  }

  // 2. Repoint each name, then write its records.
  for (const studio of named.studios) {
    const label = studio.ensSubname!;
    const owner = await resolveSubnameOwner(registry, label);
    if (!owner) {
      console.log(`skip   ${label} — not registered on chain`);
      continue;
    }
    if (!write) {
      console.log(`would  ${label} -> resolver, addr=${owner}, cgs:role=studio`);
      continue;
    }
    await setSubnameResolver(registry, label, resolver);
    await setSubnameAddress(resolver, label, owner);
    await setSubnameText(resolver, label, "cgs:role", "studio");
    await setSubnameText(resolver, label, "cgs:name", studio.name);
    console.log(`done   ${label} -> ${owner}`);
  }

  for (const agent of named.agents) {
    const label = agent.ensLabel!;
    const owner = await resolveSubnameOwner(registry, label);
    if (!owner) {
      console.log(`skip   ${label} — not registered on chain`);
      continue;
    }

    // The mandate: the largest ceiling this agent is trusted with across
    // everything it is watching. Read fresh rather than stored, same as every
    // other money figure in this codebase.
    const wants = await db.query.wishlistItems.findMany({
      where: eq(wishlistItems.userId, agent.buyerUserId),
      columns: { agentMaxUnits: true },
    });
    const ceiling = wants.reduce((max, w) => (w.agentMaxUnits && w.agentMaxUnits > max ? w.agentMaxUnits : max), 0);

    if (!write) {
      console.log(
        `would  ${label} -> resolver, addr=${owner}, cgs:maxSpend=${toDisplayAmount(ceiling, env.X402_ASSET)}, cgs:mode=${agent.mode}`,
      );
      continue;
    }

    await setSubnameResolver(registry, label, resolver);
    await setSubnameAddress(resolver, label, owner);
    await setSubnameText(resolver, label, "cgs:role", "agent");
    await setSubnameText(resolver, label, "cgs:account", agent.agentAccountId ?? "");
    await setSubnameText(resolver, label, "cgs:maxSpend", String(toDisplayAmount(ceiling, env.X402_ASSET)));
    await setSubnameText(resolver, label, "cgs:mode", agent.mode);
    console.log(`done   ${label} -> ${owner} (max ${toDisplayAmount(ceiling, env.X402_ASSET)}, ${agent.mode})`);
  }

  // 3. Read it all back off chain, so the run proves itself.
  if (write) {
    console.log("\nreading back from Sepolia:");
    for (const label of [
      ...named.studios.map((s) => s.ensSubname!),
      ...named.agents.map((a) => a.ensLabel!),
    ]) {
      const addr = await readSubnameAddress(resolver, label);
      const role = await readSubnameText(resolver, label, "cgs:role");
      const max = await readSubnameText(resolver, label, "cgs:maxSpend");
      console.log(`  ${label.padEnd(18)} addr=${addr ?? "none"} role=${role || "-"} maxSpend=${max || "-"}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
