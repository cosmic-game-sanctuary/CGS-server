import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";
import { Errors } from "../../lib/errors.js";

const MIME_BY_EXT: Record<string, string> = {
  html: "text/html",
  js: "application/javascript",
  css: "text/css",
  json: "application/json",
  wasm: "application/wasm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  data: "application/octet-stream",
};

function mimeFor(buildPath: string): string {
  const ext = buildPath.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * How much decompressed build content one publish may write to disk.
 *
 * This used to be a heap budget: every decompressed entry was collected into
 * a JS array, so the whole build sat in memory at once, and that — not the
 * compressed zip — is what OOM-killed a 512MB instance past ~90MB. Streaming
 * each entry straight to a temp file (below) means decompressed bytes never
 * accumulate in the heap; only one entry's stream chunks are live at a time.
 * So this is a disk budget now. Render's actual ephemeral-disk ceiling on the
 * free tier hasn't been measured — raise this only after confirming headroom
 * there, not just in RAM.
 */
const MAX_UNPACKED_BYTES = 250 * 1024 * 1024;

export type UnpackedFile = {
  /** Where the decompressed bytes live right now — a temp file, not the build's own path. */
  diskPath: string;
  /** The path inside the build, e.g. "assets/sprite.png" — what Pinata sees as the filename. */
  buildPath: string;
  mimeType: string;
  size: number;
};

export type UnpackedBuild = {
  files: UnpackedFile[];
  /** Deletes the temp directory. Always call this, success or failure. */
  cleanup: () => Promise<void>;
};

/**
 * Unpacks a build zip into a temp directory, one entry at a time, streaming
 * each straight to disk. Requires index.html at the effective root — without
 * it there's nothing to boot in an iframe. Matches the frontend's own local
 * preview behaviour: a build zipped as one wrapper folder (a common export
 * habit) gets that one folder stripped so index.html still lands at the
 * directory CID's root, not a level down from it.
 *
 * Takes the zip as a buffer rather than a path: JSZip has to read the central
 * directory at the end of the file before it knows what entries exist, which
 * needs random access into the whole compressed zip regardless — there's no
 * avoiding holding that once. The caller already has it in memory to pin the
 * zip itself, so handing over the same buffer costs nothing extra; reading it
 * a second time from disk here would risk both copies being live at once
 * depending on when GC runs.
 */
export async function unpackBuild(zipBuffer: Buffer): Promise<UnpackedBuild> {
  const zip = await JSZip.loadAsync(zipBuffer);

  const entries = Object.values(zip.files).filter(
    (f) => !f.dir && !f.name.includes("..") && !f.name.startsWith("/"),
  );
  if (entries.length === 0) throw Errors.validationFailed({ build: "the zip is empty" });

  const topLevelFolders = new Set(
    entries
      .map((f) => f.name.split("/"))
      .filter((parts) => parts.length > 1)
      .map((parts) => parts[0]),
  );
  const allNested = entries.every((f) => f.name.includes("/"));
  const singleWrapper = allNested && topLevelFolders.size === 1;
  const stripPrefix = singleWrapper ? `${[...topLevelFolders][0]}/` : "";

  const tempDir = await mkdtemp(path.join(tmpdir(), "cgs-build-"));
  const cleanup = () => rm(tempDir, { recursive: true, force: true });

  try {
    const files: UnpackedFile[] = [];
    let unpackedBytes = 0;

    for (const [index, entry] of entries.entries()) {
      const buildPath = stripPrefix ? entry.name.slice(stripPrefix.length) : entry.name;
      const diskPath = path.join(tempDir, String(index));

      await pipeline(entry.nodeStream("nodebuffer"), createWriteStream(diskPath));
      const { size } = await stat(diskPath);

      // Checked against bytes actually written, not the zip's own metadata —
      // this doesn't depend on JSZip's internal entry shape, only on what
      // landed on disk. Worst case this writes one oversized entry before
      // refusing, which costs disk, not heap.
      unpackedBytes += size;
      if (unpackedBytes > MAX_UNPACKED_BYTES) {
        throw Errors.validationFailed({
          build: `this build unpacks to over ${Math.round(MAX_UNPACKED_BYTES / 1024 / 1024)}MB, which is more than this server can process at once. Try exporting with compression enabled, or trimming unused assets.`,
        });
      }

      files.push({ diskPath, buildPath, mimeType: mimeFor(buildPath), size });
    }

    if (!files.some((f) => f.buildPath === "index.html")) {
      throw Errors.validationFailed({ build: "no index.html at the build's root" });
    }

    return { files, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
