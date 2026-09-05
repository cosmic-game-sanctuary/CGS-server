import { env } from "../../config/env.js";

export type CsamResult = { pass: boolean; reason?: string };

// No CSAM (child sexual abuse material) hash-matching provider is chosen or
// configured yet — there's no vendor decision anywhere in the docs and no
// credential for one in .env. This fails closed rather than faking a pass:
// nothing gets pinned to IPFS or published while this returns { pass: false }.
//
// CSAM_MODE=skip is a deliberate local escape hatch for testing the rest of
// the pipeline before a provider is chosen. It is not the default, and
// should not become one without a real decision to replace it. When a
// provider is picked (Thorn Safer, Hive Moderation, Cloudflare's CSAM
// Scanning Tool, PhotoDNA Cloud — see docs/stage-2.md), only this function
// changes; nothing else in the publish pipeline needs to know how the check
// actually works.
export async function checkImages(_buffers: Buffer[]): Promise<CsamResult> {
  if (env.CSAM_MODE === "skip") return { pass: true };
  return { pass: false, reason: "CSAM_CHECK_NOT_CONFIGURED" };
}
