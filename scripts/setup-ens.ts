// run once: tsx scripts/setup-ens.ts
// deploys the subregistry the platform owns outright, then registers the
// parent name under it through the real commit-reveal flow. Prints the
// subregistry address to paste into .env as ENS_SUBREGISTRY_ADDRESS — every
// studio subname mints against that address from then on. Do not re-run
// this once studios exist under the printed address; it deploys a new
// subregistry and registers the parent name fresh, which is only correct
// the first time. See docs/stage-7.md for the real run this already had.
import { deploySubregistry, registerParentName } from "../src/services/ens/registrar.js";
import { env } from "../src/config/env.js";

console.log(`deploying a subregistry for "${env.ENS_PARENT_NAME}.eth"...`);
const subregistryAddress = await deploySubregistry();
console.log(`subregistry deployed: ${subregistryAddress}`);

console.log(`registering "${env.ENS_PARENT_NAME}.eth" (commit, wait past MIN_COMMITMENT_AGE, reveal)...`);
const { txHash } = await registerParentName(subregistryAddress);
console.log(`registered. tx: ${txHash}`);

console.log("\nAdd this to .env:\n");
console.log(`ENS_SUBREGISTRY_ADDRESS=${subregistryAddress}`);
console.log();

process.exit(0);
