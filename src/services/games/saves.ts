import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { saveStates, games } from "../../db/schema.js";
import { AppError, Errors } from "../../lib/errors.js";

type Game = typeof games.$inferSelect;

/**
 * Cloud saves.
 *
 * The rules here are deliberately boring and deliberately stated, because the
 * failure mode of a save system is losing somebody's progress and every one of
 * these exists to make a specific way of doing that impossible.
 */

/**
 * Per slot. Browser games keep kilobytes of progress; half a megabyte is
 * generous rather than tight, and it leaves the JSON body comfortably inside
 * the server's parser limit even after escaping (see index.ts).
 */
export const MAX_SAVE_BYTES = 512 * 1024;
/** Slots 0-2. More than one because "one save per game" is our rule, not theirs. */
export const MAX_SLOTS = 3;

export function checksumOf(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function assertSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) {
    throw Errors.validationFailed({ slot: `slot must be 0-${MAX_SLOTS - 1}` });
  }
}

/** Metadata for every slot, without the payloads. */
export async function listSaves(gameId: string, userId: string) {
  const rows = await db.query.saveStates.findMany({
    where: and(eq(saveStates.gameId, gameId), eq(saveStates.userId, userId)),
    orderBy: asc(saveStates.slot),
    // The data column is deliberately absent: a save list is a menu, and
    // shipping three megabytes to draw it would be the wrong trade.
    columns: { data: false },
  });
  return rows.map((r) => ({
    slot: r.slot,
    label: r.label,
    sizeBytes: r.sizeBytes,
    checksum: r.checksum,
    device: r.device,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function readSave(gameId: string, userId: string, slot: number) {
  assertSlot(slot);
  const row = await db.query.saveStates.findFirst({
    where: and(eq(saveStates.gameId, gameId), eq(saveStates.userId, userId), eq(saveStates.slot, slot)),
  });
  if (!row) return null;
  return {
    slot: row.slot,
    label: row.label,
    data: row.data,
    sizeBytes: row.sizeBytes,
    checksum: row.checksum,
    device: row.device,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Write a slot.
 *
 * `baseVersion` is the version the client last read. Sending it turns a blind
 * overwrite into a detectable conflict: two devices playing the same game will
 * otherwise take turns destroying each other's progress, and neither will ever
 * be told. Omitting it is allowed and means "I know, overwrite" — a first write
 * has no version to name.
 */
export async function writeSave(
  game: Game,
  userId: string,
  slot: number,
  input: { data: string; label?: string | null; device?: string | null; baseVersion?: number },
) {
  assertSlot(slot);

  const sizeBytes = Buffer.byteLength(input.data, "utf8");
  if (sizeBytes > MAX_SAVE_BYTES) {
    throw Errors.validationFailed({
      data: `That save is ${Math.round(sizeBytes / 1024)}KB; the limit is ${MAX_SAVE_BYTES / 1024}KB per slot.`,
    });
  }

  const existing = await db.query.saveStates.findFirst({
    where: and(eq(saveStates.gameId, game.id), eq(saveStates.userId, userId), eq(saveStates.slot, slot)),
  });

  if (existing && input.baseVersion !== undefined && input.baseVersion !== existing.version) {
    // The whole saved state comes back with the conflict, not just the version.
    // Whoever resolves this needs to be able to show both sides, and making
    // them fetch the other one first means a second round trip during exactly
    // the moment progress is at risk.
    throw new AppError(409, "SAVE_CONFLICT", "This slot changed somewhere else since you loaded it.", {
      currentVersion: existing.version,
      updatedAt: existing.updatedAt,
      device: existing.device,
      sizeBytes: existing.sizeBytes,
      checksum: existing.checksum,
    });
  }

  const checksum = checksumOf(input.data);
  const now = new Date();

  if (existing) {
    const [updated] = await db
      .update(saveStates)
      .set({
        data: input.data,
        sizeBytes,
        checksum,
        label: input.label ?? existing.label,
        device: input.device ?? existing.device,
        version: existing.version + 1,
        updatedAt: now,
      })
      .where(eq(saveStates.id, existing.id))
      .returning({ slot: saveStates.slot, version: saveStates.version, updatedAt: saveStates.updatedAt });
    return { ...updated!, sizeBytes, checksum, created: false };
  }

  const [created] = await db
    .insert(saveStates)
    .values({
      gameId: game.id,
      userId,
      slot,
      data: input.data,
      sizeBytes,
      checksum,
      label: input.label ?? null,
      device: input.device ?? null,
    })
    .returning({ slot: saveStates.slot, version: saveStates.version, updatedAt: saveStates.updatedAt });
  return { ...created!, sizeBytes, checksum, created: true };
}

export async function deleteSave(gameId: string, userId: string, slot: number) {
  assertSlot(slot);
  const existing = await db.query.saveStates.findFirst({
    where: and(eq(saveStates.gameId, gameId), eq(saveStates.userId, userId), eq(saveStates.slot, slot)),
  });
  if (!existing) return false;
  await db.delete(saveStates).where(eq(saveStates.id, existing.id));
  return true;
}
