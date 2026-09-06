import { PinataSDK } from "pinata";
import { env } from "../../config/env.js";

const pinata = new PinataSDK({ pinataJwt: env.PINATA_JWT });

export type PinFile = { path: string; buffer: Buffer; mimeType?: string };

// pins a set of files as ONE directory CID, with each file's relative path
// (from the build zip's own root) preserved — so ipfs.io/ipfs/<cid>/index.html
// resolves. Pinning a single bare file gives a CID you can't boot from.
export async function pinDirectory(files: PinFile[]): Promise<string> {
  const fileObjects = files.map(
    (f) => new File([new Uint8Array(f.buffer)], f.path, { type: f.mimeType ?? "application/octet-stream" }),
  );
  const result = await pinata.upload.public.fileArray(fileObjects);
  return result.cid;
}

export async function pinFile(buffer: Buffer, filename: string, mimeType?: string): Promise<string> {
  const file = new File([new Uint8Array(buffer)], filename, { type: mimeType ?? "application/octet-stream" });
  const result = await pinata.upload.public.file(file);
  return result.cid;
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
