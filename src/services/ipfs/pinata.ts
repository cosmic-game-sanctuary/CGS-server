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

// never *.mypinata.cloud — it returns HTTP 200 with an error page in the
// body, a status-code check misses it entirely.
export function gatewayUrl(cid: string, path?: string): string {
  return path ? `https://ipfs.io/ipfs/${cid}/${path}` : `https://ipfs.io/ipfs/${cid}`;
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
