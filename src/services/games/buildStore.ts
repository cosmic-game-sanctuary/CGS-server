import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import logger from "../../utils/logger.utils.js";

/**
 * The uploaded build, kept where we can actually serve it.
 *
 * IPFS is still where a build lives: the CID is what goes on the listing and
 * on-chain, and it is what makes a build verifiable by someone who doesn't
 * trust us. What IPFS is not, today, is a way to get the build into a browser.
 *
 * Pinata refuses to serve HTML through a `*.mypinata.cloud` gateway at all —
 * `ERR_ID:00023`, "add a custom domain to this gateway to serve this content" —
 * and that applies to the whole directory CID, not just index.html, and to
 * authenticated reads as well as anonymous ones. Public gateways are no help
 * either: ipfs.io and dweb.link both time out on freshly pinned content,
 * because Pinata doesn't announce it to the DHT quickly. Every one of those was
 * checked against a real pinned build, not assumed.
 *
 * So delivery and provenance are separated. IPFS proves what the build is; this
 * serves it. If a custom gateway domain is ever configured, the CID is already
 * there and switching back is a change to one function.
 *
 * The zip rather than the unpacked files, because the client already knows how
 * to unpack one and run it — that is what the publish preview does, on an
 * isolated origin, and a downloaded build should go through exactly that path
 * rather than a second one written to be nearly the same.
 */

const ROOT = path.resolve(process.cwd(), "storage", "builds");

function zipPath(gameId: string): string {
  // gameId is a uuid from our own database, never user input, but resolving and
  // then checking the prefix costs nothing and makes that obvious.
  const file = path.resolve(ROOT, `${gameId}.zip`);
  if (!file.startsWith(ROOT + path.sep)) throw new Error("refusing a build path outside the store");
  return file;
}

export async function saveBuild(gameId: string, zip: Buffer): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  await writeFile(zipPath(gameId), zip);
  logger.info({ gameId, bytes: zip.length }, "build stored for serving");
}

/** The file to send, or null if this game has no stored build. */
export async function findBuild(gameId: string): Promise<string | null> {
  const file = zipPath(gameId);
  try {
    const info = await stat(file);
    return info.isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * For `removed_from_storage`. Illegal content leaves our disk as well as IPFS,
 * otherwise unpinning is theatre.
 */
export async function deleteBuild(gameId: string): Promise<void> {
  await rm(zipPath(gameId), { force: true });
}
