// The human half of moderation for reviews and comments — the two
// user-generated surfaces a game report can't cover, since delisting a whole
// game over one bad review is the wrong tool. Same shape as reports.ts and
// resolved the same way, through a script rather than an admin route, for the
// same reason: the team running the server *is* the review step right now.
import { eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { contentReports, reviews, comments, games, notifications } from "../../db/schema.js";
import { AppError, Errors } from "../../lib/errors.js";

export type ContentReportTarget = "review" | "comment";
export type ContentReportAction = "none" | "removed";

async function loadTarget(targetType: ContentReportTarget, targetId: string) {
  if (targetType === "review") {
    return db.query.reviews.findFirst({ where: eq(reviews.id, targetId) });
  }
  return db.query.comments.findFirst({ where: eq(comments.id, targetId) });
}

/**
 * File a report. Deliberately does nothing else — no auto-hide, unlike a game
 * report's immediate delist. See the comment on `contentReports` in
 * db/schema.ts for why: hiding a review on one report would hand any
 * developer a one-click way to silence honest criticism of their own game.
 * This only queues it for a human.
 */
export async function fileContentReport(input: {
  targetType: ContentReportTarget;
  targetId: string;
  reporterUserId: string;
  reason: string;
}) {
  const target = await loadTarget(input.targetType, input.targetId);
  if (!target) throw Errors.notFound(input.targetType === "review" ? "Review" : "Comment");
  if (target.userId === input.reporterUserId) {
    throw new AppError(422, "VALIDATION_FAILED", "You can't report your own.");
  }

  const [report] = await db.insert(contentReports).values(input).returning();
  return report!;
}

export async function listOpenContentReports() {
  return db.query.contentReports.findMany({ where: isNull(contentReports.resolvedAt) });
}

/**
 * `removed` deletes the underlying review or comment — the same effect as the
 * self-service delete routes added alongside this, just triggered by a
 * moderator instead of the author. `none` leaves it exactly as it was: the
 * report was looked at and the content stays up.
 */
export async function resolveContentReport(reportId: string, action: ContentReportAction) {
  const report = await db.query.contentReports.findFirst({ where: eq(contentReports.id, reportId) });
  if (!report) throw new Error(`no content report ${reportId}`);
  if (report.resolvedAt) throw new Error(`content report ${reportId} was already resolved`);

  const target = await loadTarget(report.targetType, report.targetId);
  // The content may already be gone — the author deleted it themselves in the
  // meantime, which is a fine outcome, not an error. Resolution still records
  // what was decided.
  let gameId: string | null = null;
  if (target) {
    gameId = target.gameId;
    if (action === "removed") {
      if (report.targetType === "review") {
        await db.delete(reviews).where(eq(reviews.id, report.targetId));
      } else {
        await db.delete(comments).where(eq(comments.id, report.targetId));
      }
    }
  }

  const [updated] = await db
    .update(contentReports)
    .set({ action, resolvedAt: new Date() })
    .where(eq(contentReports.id, reportId))
    .returning();

  const game = gameId ? await db.query.games.findFirst({ where: eq(games.id, gameId) }) : null;
  await db.insert(notifications).values({
    userId: report.reporterUserId,
    type: "report_resolved",
    payload: {
      reportKind: report.targetType,
      targetId: report.targetId,
      gameId: game?.id ?? null,
      slug: game?.slug ?? null,
      title: game?.title ?? null,
      action,
    },
  });

  return { report: updated!, game };
}
