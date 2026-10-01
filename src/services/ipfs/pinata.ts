import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { PinataSDK } from "pinata";
import { env } from "../../config/env.js";
import { postMultipart, type MultipartFilePart } from "./multipart.js";
import type { UnpackedFile } from "./unpack.js";

// Still used for unpinning (services/moderation/reports.ts) — a rare,
// small-payload call with nothing to stream, so the SDK's own HTTP layer is
// fine there. Only the two upload paths below bypass it; see multipart.ts.
const pinata = new PinataSDK({ pinataJwt: env.PINATA_JWT });

const AUTH_HEADERS = { Authorization: `Bearer ${env.PINATA_JWT}` };

function assertOk(res: { status: number; text: string }, what: string): void {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Pinata ${what} failed: HTTP ${res.status} ${res.text.slice(0, 500)}`);
  }
}

// "folder_from_sdk" was the Pinata SDK's own default display name for a
// directory pin when no metadata.name is given — kept here for parity, since
// what matters is every file sharing ONE common leading path segment: IPFS
// then addresses the pin at that segment, not at an implied level above it,
// which is what puts index.html at the CID's own root rather than one level
// down from it.
const DIRECTORY_NAME = "folder_from_sdk";

/**
 * Pins a set of files as ONE directory CID, with each file's relative path
 * (from the build zip's own root) preserved — so ipfs.io/ipfs/<cid>/index.html
 * resolves. Pinning a single bare file gives a CID you can't boot from.
 *
 * Streams each file straight from its temp path on disk rather than reading
 * it into a Buffer first — unpackBuild wrote it there instead of holding it in
 * a JS array specifically so this step never needs all of a build's
 * decompressed bytes in memory at once. Posts directly to Pinata's REST API
 * rather than through the SDK's `fileArray` helper: that helper builds the
 * request with `fetch()` and a `FormData`, which (measured directly, see
 * scripts/bench-publish-memory.ts) does not actually stream in Node — it
 * materializes the whole multipart body before sending, which is the single
 * largest cost in the pipeline, bigger than anything in our own code.
 */
export async function pinDirectory(files: UnpackedFile[]): Promise<string> {
  const fileParts: MultipartFilePart[] = files.map((f) => ({
    name: "file",
    filename: `${DIRECTORY_NAME}/${f.buildPath}`,
    contentType: f.mimeType,
    size: f.size,
    open: () => createReadStream(f.diskPath),
  }));

  const res = await postMultipart(
    "https://api.pinata.cloud/pinning/pinFileToIPFS",
    AUTH_HEADERS,
    [
      { name: "pinataMetadata", value: JSON.stringify({ name: DIRECTORY_NAME }) },
      { name: "pinataOptions", value: JSON.stringify({ cidVersion: 1 }) },
    ],
    fileParts,
  );
  assertOk(res, "pinDirectory");
  const body = JSON.parse(res.text) as { IpfsHash: string };
  return body.IpfsHash;
}

async function pinOne(open: () => Readable, size: number, filename: string, mimeType: string): Promise<string> {
  const res = await postMultipart(
    "https://uploads.pinata.cloud/v3/files",
    AUTH_HEADERS,
    [{ name: "network", value: "public" }, { name: "name", value: filename }],
    [{ name: "file", filename, contentType: mimeType, size, open }],
  );
  assertOk(res, "pinFile");
  const body = JSON.parse(res.text) as { data: { cid: string } };
  return body.data.cid;
}

export async function pinFile(buffer: Buffer, filename: string, mimeType?: string): Promise<string> {
  return pinOne(() => Readable.from(buffer), buffer.length, filename, mimeType ?? "application/octet-stream");
}

/**
 * Same as `pinFile`, but for something already on disk — the zip upload in
 * particular, which would otherwise be the one remaining moment a build's
 * full size sits in memory for no reason beyond pinning it.
 */
export async function pinFileFromPath(path: string, filename: string, mimeType: string): Promise<string> {
  const { size } = await stat(path);
  return pinOne(() => createReadStream(path), size, filename, mimeType);
}

// Which gateway actually serves what we pinned.
//
// The earlier note here said never *.mypinata.cloud, and that is right about
// the *shared* gateway — it answers 200 with an error page in the body, so a
// status-code check misses it. It is wrong about a **dedicated** gateway: the
// subdomain Pinata assigns an account serves the same CIDs in about a second,
// with no token, and is a different origin from the app, which is what the
// build iframe needs anyway.
//
// ipfs.io is the fallback and it is not a good one. Freshly pinned content is
// not reliably reachable through it — every CID from this account timed out
// with a 504 after nearly 30 seconds, because the public gateway has to find
// the content on the DHT and Pinata does not announce it quickly. That is
// invisible on the server and shows up as a broken image, or worse, a game
// that never boots.
const GATEWAY_HOST = env.PINATA_GATEWAY?.replace(/^https?:\/\//, "").replace(/\/+$/, "");

// `ipfs.io` was the documented fallback and it does not work for this account's
// content: it times out on both a fresh cover image and a build directory,
// because Pinata does not announce freshly pinned content to the DHT quickly.
// Pinata's own public gateway does serve it, and serves images correctly
// (checked: 200 image/png on a real cover). It refuses HTML specifically —
// "HTML content cannot be served through the pinata public gateway",
// ERR_ID:00023 — which is why builds are served from disk instead and only
// covers and media come through here. A dedicated gateway on a custom domain
// lifts that, and `PINATA_GATEWAY` is where it goes when there is one.
export function gatewayUrl(cid: string, path?: string): string {
  const host = GATEWAY_HOST ?? "gateway.pinata.cloud";
  const base = `https://${host}/ipfs/${cid}`;
  return path ? `${base}/${path}` : base;
}

// For `removed_from_storage`: genuinely illegal content actually leaves
// IPFS, not just the catalog. Pinata's delete takes file *ids*, not CIDs —
// there's no delete-by-CID call — so this looks the file up by CID first.
// A CID that isn't found is treated as already gone, not an error: nothing
// downstream should fail just because storage got ahead of the database.
export async function unpinByCid(cid: string): Promise<void> {
  const matches = await pinata.files.public.list().cid(cid).all();
  if (matches.length === 0) return;
  await pinata.files.public.delete(matches.map((f) => f.id));
}
