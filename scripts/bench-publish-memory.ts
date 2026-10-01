import { readFile, rm } from "node:fs/promises";
import { ingestBuild } from "../src/services/games/builds.js";
import { unpinByCid } from "../src/services/ipfs/pinata.js";

// Stage 1 acceptance test: drives the real publish pipeline (ingestBuild,
// which calls the real unpackBuild + pinFile + pinDirectory against Pinata)
// against an 85MB-unpacked test build, sampling RSS throughout, and reports
// peak. Run under a constrained heap to match the 512MB free-tier instance:
//
//   node --max-old-space-size=400 --import tsx scripts/bench-publish-memory.ts <path-to-zip>

const zipPath = process.argv[2];
if (!zipPath) {
  console.error("usage: bench-publish-memory.ts <path-to-test-zip>");
  process.exit(1);
}

let peakRss = 0;
const sampler = setInterval(() => {
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
}, 50);

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

console.log(`starting: ${mb((await import("node:fs")).statSync(zipPath).size)}MB zip, RSS now ${mb(process.memoryUsage().rss)}MB`);

const start = Date.now();
const artifacts = await ingestBuild(zipPath, "bench-test");
const elapsed = Date.now() - start;

clearInterval(sampler);

console.log(`done in ${elapsed}ms`);
console.log(`buildCid: ${artifacts.buildCid}`);
console.log(`buildZipCid: ${artifacts.buildZipCid}`);
console.log(`buildSizeKb: ${artifacts.buildSizeKb}`);
console.log(`peak RSS during ingestBuild: ${mb(peakRss)}MB`);

// Functional check: the directory CID must actually serve index.html at its
// root, through the real gateway, not just "pinata returned a cid". Retried
// over a few minutes — documented Pinata behavior is that fresh content isn't
// announced to the DHT immediately, so a single attempt isn't a fair test.
const gatewayUrl = `https://gateway.pinata.cloud/ipfs/${artifacts.buildCid}/index.html`;
console.log(`fetching ${gatewayUrl} (retrying for up to 3 minutes)...`);
for (let attempt = 1; attempt <= 9; attempt++) {
  try {
    const res = await fetch(gatewayUrl, { signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    console.log(`attempt ${attempt}: ${res.status}, body: ${JSON.stringify(body.slice(0, 120))}`);
    break;
  } catch (err) {
    console.log(`attempt ${attempt}: ${err instanceof Error ? err.message : err}`);
    if (attempt < 9) await new Promise((r) => setTimeout(r, 20_000));
  }
}

// Clean up: unpin both CIDs so this test doesn't consume real quota.
console.log("cleaning up pins...");
await unpinByCid(artifacts.buildCid);
await unpinByCid(artifacts.buildZipCid);
await rm(zipPath, { force: true });
console.log("done.");
