import { desc, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { gameBuilds, games } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { unpackBuild } from "../ipfs/unpack.js";
import { pinDirectory, pinFile } from "../ipfs/pinata.js";
import { checkImages } from "../moderation/csam.js";
import { saveBuild } from "./buildStore.js";

/**
 * Getting a zip from a developer's machine into something we can serve, prove
 * and re-serve later.
 *
 * This used to live inline in the publish route, which meant the *second*
 * build a game ever had would have gone through a different path from the
 * first — and the part that would have been easy to leave out is the
 * moderation gate. A game that passed a check at v1 and could then ship
 * anything as v2 is not moderated at all. Same function, both times.
 */

const IMAGE_MIME = /^image\//;

export type BuildArtifacts = {
  /** What the build *is*: the unpacked directory, pinned. Provenance. */
  buildCid: string;
  /** The same bytes as a zip. Delivery — Pinata's gateway refuses HTML. */
  buildZipCid: string;
  buildSizeKb: number;
  /** Kept so the caller can store it locally without re-reading the upload. */
  zip: Buffer;
};

/**
 * Unpack, moderate, pin. Nothing is pinned until the check passes, which is
 * what "fails closed" has to mean — see services/moderation/csam.ts.
 *
 * `extraImages` exists so the publish route can put its screenshots through
 * the same single check as the build's own images, before either is pinned.
 */
export async function ingestBuild(
  zip: Buffer,
  nameHint: string,
  extraImages: Buffer[] = [],
): Promise<BuildArtifacts> {
  const files = await unpackBuild(zip);

  const images = [
    ...extraImages,
    ...files.filter((f) => IMAGE_MIME.test(f.mimeType ?? "")).map((f) => f.buffer),
  ];
  const csam = await checkImages(images);
  if (!csam.pass) {
    throw new AppError(422, "MODERATION_BLOCKED", "This upload can't be accepted yet.", {
      reason: csam.reason,
    });
  }

  const [buildCid, buildZipCid] = await Promise.all([
    pinDirectory(files),
    pinFile(zip, `${nameHint}-build.zip`, "application/zip"),
  ]);

  return {
    buildCid,
    buildZipCid,
    buildSizeKb: Math.round(files.reduce((sum, f) => sum + f.buffer.length, 0) / 1024),
    zip,
  };
}

/** The version number a new build for this game should carry. 1 if it's the first. */
export async function nextVersion(gameId: string): Promise<number> {
  const latest = await db.query.gameBuilds.findFirst({
    where: eq(gameBuilds.gameId, gameId),
    orderBy: desc(gameBuilds.version),
    columns: { version: true },
  });
  return (latest?.version ?? 0) + 1;
}

/**
 * Write a version into the history and make it the one being served.
 *
 * The two halves are deliberate: `gameBuilds` is append-only and each row keeps
 * its own CID forever, so what a game *was* at v1 stays checkable after v4
 * replaces it. The columns on `games` are a mirror of whichever row is current,
 * which is the reason nothing that serves a build — download, build.zip,
 * buildStore — needed to learn that versions exist.
 */
export async function commitBuild(
  gameId: string,
  artifacts: BuildArtifacts,
  meta: { label?: string | null; notes?: string | null; hcsTxId?: string | null } = {},
) {
  const version = await nextVersion(gameId);

  const [row] = await db
    .insert(gameBuilds)
    .values({
      gameId,
      version,
      label: meta.label ?? null,
      notes: meta.notes ?? null,
      buildCid: artifacts.buildCid,
      buildZipCid: artifacts.buildZipCid,
      buildSizeKb: artifacts.buildSizeKb,
      hcsTxId: meta.hcsTxId ?? null,
    })
    .returning();

  await db
    .update(games)
    .set({
      buildCid: artifacts.buildCid,
      buildZipCid: artifacts.buildZipCid,
      buildSizeKb: artifacts.buildSizeKb,
      buildVersion: version,
      updatedAt: new Date(),
    })
    .where(eq(games.id, gameId));

  // Overwrites the served copy, on purpose: owners get the patch. The previous
  // version is not lost — its CID is in the row above, and `findBuild` pulls
  // any zip back from IPFS on demand.
  await saveBuild(gameId, artifacts.zip);

  return row!;
}

/** Public version history, newest first. Provenance, so it needs no auth. */
export async function listBuilds(gameId: string) {
  const rows = await db.query.gameBuilds.findMany({
    where: eq(gameBuilds.gameId, gameId),
    orderBy: desc(gameBuilds.version),
  });
  return rows.map((b) => ({
    version: b.version,
    label: b.label,
    notes: b.notes,
    buildCid: b.buildCid,
    buildSizeKb: b.buildSizeKb,
    hcsTxId: b.hcsTxId,
    createdAt: b.createdAt,
  }));
}
