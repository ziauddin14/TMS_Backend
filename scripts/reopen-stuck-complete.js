// Reopens the tasks the code before the reopen fix left "complete" below 100% (category A of
// scripts/reopen-stuck-complete/plan.js — task 261006 is the case that showed it), exactly as the
// app now reopens a task. Categories B and C are listed in the report only. Sends no notification.
// Run it AFTER the backend with the reopen fix is deployed, so no new task can get stuck afterwards.
//
//   node scripts/reopen-stuck-complete.js                      (dry run, default)
//   node scripts/reopen-stuck-complete.js --commit             (real write)
//   node scripts/reopen-stuck-complete.js --rollback           (rollback dry run)
//   node scripts/reopen-stuck-complete.js --rollback --commit  (real rollback, from the ledger)
//
// Dry run: read-only database queries + a Markdown/JSON report of everything that WOULD be written
// (--report-dir <dir>, default backend/import-reports). --commit additionally requires every check
// to pass and a successful mongodump backup taken first (backend/import-backups). Reuses the
// conventions of the other data scripts and the HistoricalImportRecord ledger. It never prints the
// connection string or any credential, and its output carries task codes only.
const mongoose = require('mongoose');

// Must run before any model is compiled: otherwise Mongoose would auto-create collections and
// auto-build indexes on connect — database writes, which a dry run must never make.
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const fs = require('fs');
const path = require('path');
const env = require('../src/config/env');
const { connectDB } = require('../src/config/db');
const Task = require('../src/models/Task');
const TaskUpdate = require('../src/models/TaskUpdate');
const Notification = require('../src/models/Notification');
const HistoricalImportRecord = require('../src/models/HistoricalImportRecord');
const { takeBackup } = require('./lib/mongodump-backup');
const { fingerprint } = require('./synthetic-ratings/commit');
const { loadPlan } = require('./reopen-stuck-complete/load');
const { LEDGER_ACTION, sameTimeStatus } = require('./reopen-stuck-complete/plan');
const { applyPlan, rollbackAll, planRollback } = require('./reopen-stuck-complete/commit');
const { renderPlanReport, renderRollbackReport } = require('./reopen-stuck-complete/report');

const IMPORT_BATCH = 'reopen-stuck-complete-v1';
const READ_SET = { $or: [{ status: 'complete' }, { status: 'closed', completionPercent: { $lt: 100 } }] };

function parseArgs(argv) {
  const args = { commit: false, rollback: false, reportDir: path.resolve(__dirname, '..', 'import-reports') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--commit') args.commit = true;
    else if (argv[i] === '--rollback') args.rollback = true;
    else if (argv[i] === '--report-dir') args.reportDir = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function backup(label) {
  const { dir, collections } = takeBackup({
    uri: env.MONGODB_URI,
    rootDir: path.resolve(__dirname, '..', 'import-backups'),
    label,
    mustContain: [Task.collection.name, HistoricalImportRecord.collection.name],
  });
  console.log(`Backup written to ${dir} (${collections.map((c) => `${c.collection}: ${c.bytes} bytes`).join(', ')})`);
  return dir;
}

function writeReports(args, name, markdown, json) {
  fs.mkdirSync(args.reportDir, { recursive: true });
  const base = path.join(args.reportDir, name);
  fs.writeFileSync(`${base}.md`, markdown);
  fs.writeFileSync(`${base}.json`, JSON.stringify(json, null, 2));
  console.log(`Report: ${base}.md`);
  console.log(`Plan JSON: ${base}.json`);
}

// Every task this plan read that is NOT planned must come out of a commit byte-identical.
async function otherFingerprints(plan) {
  const planned = new Set(plan.items.map((i) => i.code));
  const docs = await Task.find(READ_SET).sort({ codeNumber: 1 }).lean();
  return docs.filter((d) => !planned.has(d.codeNumber)).map((d) => `${d.codeNumber}:${fingerprint(d)}`);
}

async function runFix(args, now) {
  const mode = args.commit ? 'COMMIT' : 'DRY RUN';
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const meta = { mode, generatedAt: now.toISOString(), importBatch: IMPORT_BATCH };
  const plan = await loadPlan(now);

  console.log(
    `${mode}: ${plan.totals.toRepair} stuck task(s) to reopen, ${plan.totals.anomalies} anomaly(ies), ${plan.totals.alreadyRepaired} reopened by an earlier run · report only: ${plan.totals.lateOnlyByLaterUpdate} late only because of a later update, ${plan.totals.closedAfterDrop} closed after dropping below 100%`
  );
  Object.entries(plan.byNewStatus).forEach(([status, count]) => console.log(`  → ${status}: ${count}`));
  plan.checks.forEach((c) => console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`));

  if (!args.commit) {
    writeReports(args, `reopen-stuck-complete-dry-run-${stamp}`, renderPlanReport(plan, { meta }), { meta, plan });
    if (!plan.ok) {
      process.exitCode = 1;
      console.log('Dry run complete — checks FAILED (see above). Nothing was written to the database.');
    } else {
      console.log('Dry run complete — nothing was written to the database.');
    }
    return;
  }

  if (!plan.ok) throw new Error('Refusing to commit: one or more checks failed (see above).');
  if (plan.items.length === 0) {
    console.log('Nothing to reopen. No backup taken, nothing written.');
    return;
  }

  const backupDir = backup('before-reopen-stuck-complete');
  const plannedIds = plan.items.map((i) => new mongoose.Types.ObjectId(i.taskId));
  const before = {
    others: await otherFingerprints(plan),
    taskUpdates: await TaskUpdate.countDocuments({}),
    notifications: await Notification.countDocuments({ taskId: { $in: plannedIds } }),
  };
  const applied = await applyPlan(plan, { importBatch: IMPORT_BATCH, now, log: (line) => console.log(line) });

  // Verification: every reopened task reads back as planned; every other task the plan read is
  // byte-identical; no TaskUpdate was created; no notification about these tasks was sent.
  const problems = [];
  const skippedCodes = new Set(applied.skipped.map((s) => s.code));
  const repairedItems = plan.items.filter((i) => !skippedCodes.has(i.code));
  const repairedDocs = new Map((await Task.find({ codeNumber: { $in: repairedItems.map((i) => i.code) } }).lean()).map((d) => [d.codeNumber, d]));
  repairedItems.forEach((item) => {
    const doc = repairedDocs.get(item.code);
    if (!doc) problems.push(`${item.code}: not found after the write`);
    else if (doc.status !== item.to.status || doc.performanceRating !== item.to.performanceRating || !sameTimeStatus(doc.timeStatus, item.to.timeStatus) || doc.completedAt) {
      problems.push(`${item.code}: reads back as ${doc.status} / "${doc.performanceRating}", expected ${item.to.status} / "${item.to.performanceRating}"`);
    }
  });
  const othersAfter = await otherFingerprints(plan);
  const verification = {
    allRepaired: problems.length === 0,
    problems,
    othersUnchanged: JSON.stringify(othersAfter) === JSON.stringify(before.others),
    othersCount: othersAfter.length,
    taskUpdates: { before: before.taskUpdates, after: await TaskUpdate.countDocuments({}) },
    notifications: { before: before.notifications, after: await Notification.countDocuments({ taskId: { $in: plannedIds } }) },
  };
  const result = { ...applied, backupDir };
  console.log(`COMMIT RESULT: ${JSON.stringify({ repaired: applied.repaired, skipped: applied.skipped.length, allRepaired: verification.allRepaired, othersUnchanged: verification.othersUnchanged })}`);
  writeReports(args, `reopen-stuck-complete-commit-${stamp}`, renderPlanReport(plan, { meta, result, verification }), { meta, plan, result, verification });
  if (
    !verification.allRepaired ||
    !verification.othersUnchanged ||
    verification.taskUpdates.before !== verification.taskUpdates.after ||
    verification.notifications.before !== verification.notifications.after
  ) {
    throw new Error('Post-commit verification failed (see the report). The backup above restores the previous state; --rollback undoes this run from the ledger.');
  }
}

async function runRollback(args, now) {
  const mode = args.commit ? 'COMMIT' : 'DRY RUN';
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const meta = { mode, generatedAt: now.toISOString() };

  const records = await HistoricalImportRecord.find({ action: LEDGER_ACTION }).sort({ taskCode: 1 }).lean();
  const tasks = await Task.find({ _id: { $in: records.map((r) => r.targetId) } }).lean();
  const taskById = new Map(tasks.map((t) => [String(t._id), t]));
  const rows = records.map((r) => ({ code: r.taskCode, ...planRollback(r, taskById.get(String(r.targetId))) }));
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.action]: (acc[r.action] || 0) + 1 }), {});
  console.log(`ROLLBACK ${mode}: ${records.length} active reopen record(s) — ${JSON.stringify(counts)}`);

  if (!args.commit) {
    writeReports(args, `reopen-stuck-complete-rollback-dry-run-${stamp}`, renderRollbackReport(rows, { meta }), { meta, rows });
    console.log('Rollback dry run complete — nothing was written to the database.');
    return;
  }
  if (records.length === 0) {
    console.log('Nothing to roll back. No backup taken, nothing written.');
    return;
  }
  const backupDir = backup('before-reopen-stuck-complete-rollback');
  const rolledBack = await rollbackAll({ now, log: (line) => console.log(line) });
  const result = { ...rolledBack, backupDir };
  console.log(`ROLLBACK RESULT: ${JSON.stringify({ restored: result.restored, ledgerOnly: result.ledgerOnly, skipped: result.skipped.length })}`);
  writeReports(args, `reopen-stuck-complete-rollback-commit-${stamp}`, renderRollbackReport(rows, { meta, result }), { meta, rows, result });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await connectDB();
  try {
    const now = new Date();
    if (args.rollback) await runRollback(args, now);
    else await runFix(args, now);
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
