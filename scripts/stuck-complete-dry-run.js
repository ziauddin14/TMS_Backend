// READ-ONLY review: the tasks the code before the reopen fix left in the wrong state (task 261006):
//   A. stuck — "complete" below 100% after reaching 100%: what scripts/reopen-stuck-complete.js
//      would reopen, and any it would refuse (anomalies);
//   B. complete at 100% but shown late only because of a later update — report only;
//   C. closed below 100% after reaching 100% and dropping again — report only.
// The categories are explained in scripts/reopen-stuck-complete/plan.js.
//
//   node scripts/stuck-complete-dry-run.js          (human-readable report)
//   node scripts/stuck-complete-dry-run.js --json   (the same, as JSON)
//
// It never writes: find-only queries on lean documents; Mongoose's automatic index building and
// collection creation are switched off before any model is compiled (they would be writes); there
// is no write path in this file at all; and it prints to stdout only — no report file is written.
// It never prints the connection string or any credential, and lists task codes only.
const mongoose = require('mongoose');

// Must run before any model is compiled: otherwise Mongoose would auto-create collections and
// auto-build indexes on connect — database writes, which this script must never make.
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const { connectDB } = require('../src/config/db');
const { loadPlan } = require('./reopen-stuck-complete/load');

function parseArgs(argv) {
  const args = { json: false };
  argv.forEach((arg) => {
    if (arg === '--json') args.json = true;
    else throw new Error(`Unknown argument: ${arg} (this script only reads; it has no write options)`);
  });
  return args;
}

const day = (value) => (value ? String(value).slice(0, 10) : '-');
const ts = (t) => (t ? `${t.type} ${t.days}` : '-');

function printList(title, rows, line) {
  console.log(`\n${title} — ${rows.length}`);
  if (!rows.length) console.log('   (none)');
  rows.forEach((row) => console.log(`   ${line(row)}`));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await connectDB();
  try {
    const plan = await loadPlan(new Date());
    if (args.json) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    console.log(`Stuck complete tasks — read only, nothing was written. Database: ${mongoose.connection.name}`);
    printList(
      'A. Stuck: complete below 100% — reopen-stuck-complete.js would reopen these',
      plan.items,
      (i) =>
        `${i.code}  ${i.completionPercent}%  deadline=${day(i.deadline)}  lastUpdate=${day(i.lastUpdateAt)}  reached100=${day(i.reached100At)}  ${i.from.status}→${i.to.status}  time=${ts(i.from.timeStatus)}→${ts(i.to.timeStatus)}  rating=${i.from.performanceRating}→${i.to.performanceRating} (${i.ratingKind})`
    );
    printList('   Anomalies — never reopened; --commit refuses while there are any', plan.anomalies, (a) => a);
    printList(
      'B. Complete at 100%, shown late only because of a later update — report only',
      plan.lateOnlyByLaterUpdate,
      (r) => `${r.code}  shownLate=${r.shownLateDays}  reached100=${day(r.completedOn)} (${r.daysBeforeDeadline} day(s) before the deadline)  lastUpdate=${day(r.lastUpdateAt)}  imported=${r.imported}`
    );
    printList(
      'C. Closed below 100% after reaching 100% — report only',
      plan.closedAfterDrop,
      (r) => `${r.code}  ${r.completionPercent}%  reached100=${day(r.reached100At)}  dropped=${day(r.droppedAt)}  closed=${day(r.closedAt)}  imported=${r.imported}`
    );
    const statuses = Object.entries(plan.byNewStatus).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'none';
    console.log(
      `\nTotals: to reopen ${plan.totals.toRepair} (${statuses}) · anomalies ${plan.totals.anomalies} · reopened by an earlier run ${plan.totals.alreadyRepaired} · B ${plan.totals.lateOnlyByLaterUpdate} · C ${plan.totals.closedAfterDrop}`
    );
    console.log('\nDry run complete — nothing was written to the database.');
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
