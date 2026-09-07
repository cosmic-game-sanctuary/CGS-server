// list open reports:  tsx scripts/resolve-content-report.ts
// resolve one:        tsx scripts/resolve-content-report.ts <reportId> none|removed
//
// Reports against a review or a comment — see report.routes.ts and
// db/schema.ts's comment on `contentReports` for why these don't auto-hide the
// way a game report auto-delists. "none" leaves the content up; "removed"
// deletes it, same as the author's own delete route would.
import {
  listOpenContentReports,
  resolveContentReport,
  type ContentReportAction,
} from "../src/services/moderation/contentReports.js";

const [reportId, action] = process.argv.slice(2);
const validActions: ContentReportAction[] = ["none", "removed"];

if (!reportId) {
  const open = await listOpenContentReports();
  if (open.length === 0) {
    console.log("no open content reports");
  } else {
    console.log(`${open.length} open report(s):\n`);
    for (const r of open) {
      console.log(`${r.id}  ${r.targetType} ${r.targetId}  reported ${r.reportedAt.toISOString()}\n  "${r.reason}"\n`);
    }
    console.log("resolve one: tsx scripts/resolve-content-report.ts <reportId> none|removed");
  }
  process.exit(0);
}

if (!action || !validActions.includes(action as ContentReportAction)) {
  console.error("usage: tsx scripts/resolve-content-report.ts <reportId> none|removed");
  process.exit(1);
}

const { report } = await resolveContentReport(reportId, action as ContentReportAction);
console.log(`report ${report.id} resolved: ${action}`);
process.exit(0);
