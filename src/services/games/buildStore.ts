import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import logger from "../../utils/logger.utils.js";
import { gatewayUrl } from "../ipfs/pinata.js";

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
 *
 * Disk is a cache, not the record. The zip is pinned too (`games.build_zip_cid`),
 * so a build missing locally is fetched back and re-cached rather than lost.
 * That is what makes a game publishable on one machine and playable on another,
 * and what lets a deploy survive an ephemeral filesystem. The reason it works
 * at all is that Pinata's refusal is about HTML specifically: a directory CID
 * resolves to index.html and 403s, while application/zip is served normally.
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

/** The file to send, or null if it isn't on this disk. */
async function findLocal(gameId: string): Promise<string | null> {
  const file = zipPath(gameId);
  try {
    const info = await stat(file);
    return info.isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * The file to send, fetching it back from IPFS first if this machine doesn't
 * have it. `zipCid` is null for anything published before builds were pinned
 * as a zip; those really are only on the machine that made them.
 */
export async function findBuild(gameId: string, zipCid?: string | null): Promise<string | null> {
  const local = await findLocal(gameId);
  if (local) return local;
  if (!zipCid) return null;

  try {
    const response = await fetch(gatewayUrl(zipCid), { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      logger.warn({ gameId, zipCid, status: response.status }, "build not retrievable from IPFS");
      return null;
    }
    const body = Buffer.from(await response.arrayBuffer());
    // A gateway that answers 200 with an error page would otherwise be cached
    // as if it were the build. Every zip starts "PK".
    if (body.subarray(0, 2).toString() !== "PK") {
      logger.warn({ gameId, zipCid }, "IPFS returned something that isn't a zip");
      return null;
    }
    await saveBuild(gameId, body);
    logger.info({ gameId, zipCid, bytes: body.length }, "build re-cached from IPFS");
    return zipPath(gameId);
  } catch (err) {
    logger.error({ err, gameId, zipCid }, "fetching the build from IPFS failed");
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
