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
export async function checkImages(buffers: Buffer[]): Promise<CsamResult> {
  if (env.CSAM_MODE === "skip") return { pass: true };
  return runProvider(buffers);
}

// The seam a real provider drops into. Every candidate (Cloudflare's CSAM
// Scanning Tool, PhotoDNA Cloud, Thorn Safer, Hive Moderation) has the same
// shape — hash or upload the image, get back match/no-match — so swapping one
// in means implementing this function and nothing else. Both call sites, the
// upload route and any future one, only ever see `checkImages`.
//
// A provider that errors or times out must return { pass: false }, never
// `true`. "We couldn't check" and "we checked and it's fine" are different
// answers, and only one of them is safe to store.
async function runProvider(_buffers: Buffer[]): Promise<CsamResult> {
  return { pass: false, reason: "CSAM_CHECK_NOT_CONFIGURED" };
}
