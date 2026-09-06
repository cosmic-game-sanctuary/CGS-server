// list open reports:  tsx scripts/resolve-report.ts
// resolve one:        tsx scripts/resolve-report.ts <reportId> none|delisted|removed_from_storage
//
// A report already delists its game immediately (report.routes.ts) — this is
// the human review that decides what happens after: "none" restores a false
// report, "delisted" confirms it, "removed_from_storage" unpins the game's
// build/media from IPFS entirely for genuinely illegal content.
import { listOpenReports, resolveReport, type ReportAction } from "../src/services/moderation/reports.js";

const [reportId, action] = process.argv.slice(2);
const validActions: ReportAction[] = ["none", "delisted", "removed_from_storage"];

if (!reportId) {
  const open = await listOpenReports();
  if (open.length === 0) {
    console.log("no open reports");
  } else {
    console.log(`${open.length} open report(s):\n`);
    for (const r of open) {
      console.log(`${r.id}  game ${r.gameId}  reported ${r.reportedAt.toISOString()}\n  "${r.reason}"\n`);
    }
    console.log("resolve one: tsx scripts/resolve-report.ts <reportId> none|delisted|removed_from_storage");
  }
  process.exit(0);
}

if (!action || !validActions.includes(action as ReportAction)) {
  console.error("usage: tsx scripts/resolve-report.ts <reportId> none|delisted|removed_from_storage");
  process.exit(1);
}

const { report, game } = await resolveReport(reportId, action as ReportAction);
console.log(`report ${report!.id} resolved: ${action}`);
console.log(`game ${game!.id} (${game!.slug}) status is now "${game!.status}"`);
process.exit(0);
