// The human half of moderation. POST /api/reports (report.routes.ts) already
// does the immediate half — delisting on report, before anyone looks at it.
// This is what a person decides after actually reviewing one, run via
// scripts/resolve-report.ts. There's no admin route or admin auth model for
// this: the team running the server *is* the review step for a hackathon
// demo, the same shape as scripts/retry-failed-splits.ts.
import { eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { games, gameMedia, moderationReports } from "../../db/schema.js";
import { unpinByCid } from "../ipfs/pinata.js";
import { deleteBuild } from "../games/buildStore.js";

export type ReportAction = "none" | "delisted" | "removed_from_storage";

export async function listOpenReports() {
  return db.query.moderationReports.findMany({ where: isNull(moderationReports.resolvedAt) });
}

export async function resolveReport(reportId: string, action: ReportAction) {
  const report = await db.query.moderationReports.findFirst({ where: eq(moderationReports.id, reportId) });
  if (!report) throw new Error(`no report ${reportId}`);
  if (report.resolvedAt) throw new Error(`report ${reportId} was already resolved`);

  const game = await db.query.games.findFirst({ where: eq(games.id, report.gameId) });
  if (!game) throw new Error(`report ${reportId}'s game ${report.gameId} no longer exists`);

  if (action === "none") {
    // the report's immediate delist turned out to be unwarranted. Only
    // "delisted" ever gets restored — a game already "removed" stays removed,
    // there's no path back once storage is actually gone.
    if (game.status === "delisted") {
      await db.update(games).set({ status: "published" }).where(eq(games.id, game.id));
    }
  } else if (action === "removed_from_storage") {
    // genuinely illegal content: unpin everything this game ever put on
    // IPFS — the build, the cover, every screenshot/clip — then flip status.
    // Unlike delisting, this ends access for existing owners too; that's the
    // one deliberate exception to "delisting never revokes access."
    const media = await db.query.gameMedia.findMany({ where: eq(gameMedia.gameId, game.id) });
    const cids = [game.buildCid, game.coverCid, ...media.map((m) => m.cid)].filter(
      (c): c is string => typeof c === "string",
    );
    for (const cid of cids) await unpinByCid(cid);
    // And our own copy, which is the one that actually gets served. Unpinning
    // without this would leave the content one authenticated request away.
    await deleteBuild(game.id);
    await db.update(games).set({ status: "removed" }).where(eq(games.id, game.id));
  }
  // action === "delisted": confirms the report's own immediate delist stands.
  // The game is already delisted; nothing more to change.

  const [updatedReport] = await db
    .update(moderationReports)
    .set({ action, resolvedAt: new Date() })
    .where(eq(moderationReports.id, reportId))
    .returning();

  const updatedGame = await db.query.games.findFirst({ where: eq(games.id, game.id) });
  return { report: updatedReport, game: updatedGame };
}
