import JSZip from "jszip";
import { Errors } from "../../lib/errors.js";
import type { PinFile } from "./pinata.js";

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

function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

// unpacks an uploaded build zip into the flat file list Pinata's directory
// upload wants. Requires index.html at the effective root — without it
// there's nothing to boot in an iframe. Matches the frontend's own local
// preview behaviour: a build zipped as one wrapper folder (a common export
// habit) gets that one folder stripped so index.html still lands at the
// CID root, not a level down from it.
export async function unpackBuild(zipBuffer: Buffer): Promise<PinFile[]> {
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

  const files: PinFile[] = [];
  for (const entry of entries) {
    const path = stripPrefix ? entry.name.slice(stripPrefix.length) : entry.name;
    const buffer = await entry.async("nodebuffer");
    files.push({ path, buffer, mimeType: mimeFor(path) });
  }

  if (!files.some((f) => f.path === "index.html")) {
    throw Errors.validationFailed({ build: "no index.html at the build's root" });
  }

  return files;
}
