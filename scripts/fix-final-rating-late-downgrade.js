// Corrects the stored band of FINAL synthetic ratings (an admin changed the estimate) whose task was
// completed late: under the owner's rule such a rating is rated like a real one with the percent
// the admin entered — ONE level down when late (src/services/task.service.js computeFinalRating).
// Before that rule every final band was stored as the plain band of the percent. Run it AFTER the
// backend with the rule is deployed, so no new final rating can be stored the old way afterwards.
//
//   node scripts/fix-final-rating-late-downgrade.js                      (dry run, default)
//   node scripts/fix-final-rating-late-downgrade.js --commit             (real write)
//   node scripts/fix-final-rating-late-downgrade.js --rollback           (rollback dry run)
//   node scripts/fix-final-rating-late-downgrade.js --rollback --commit  (real rollback, from the ledger)
//
// Dry run: read-only database queries + a Markdown/JSON report of everything that WOULD be written
// (--report-dir <dir>, default backend/import-reports). --commit additionally requires every check
// to pass and a successful mongodump backup taken first (backend/import-backups). Reuses the
// synthetic-ratings conventions and the HistoricalImportRecord ledger. It never prints the
// connection string or any credential.
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
const HistoricalImportRecord = require('../src/models/HistoricalImportRecord');
const { computeFinalRating } = require('../src/services/task.service');
const { isFinalRating, ASSIGN_LEDGER_ACTION } = require('../src/utils/syntheticRating');
const { takeBackup } = require('./lib/mongodump-backup');
const { fingerprint } = require('./synthetic-ratings/commit');
const { buildPlan, LEDGER_ACTION } = require('./final-rating-late-downgrade/plan');
const { applyPlan, rollbackAll, planRollback } = require('./final-rating-late-downgrade/commit');
const { renderPlanReport, renderRollbackReport } = require('./final-rating-late-downgrade/report');

const IMPORT_BATCH = 'final-rating-late-downgrade-v1';

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

async function loadPlan() {
  const [tasks, ledgerRecords, assignRecords] = await Promise.all([
    Task.find({ syntheticRating: { $exists: true } }).sort({ codeNumber: 1 }).lean(),
    HistoricalImportRecord.find({ action: LEDGER_ACTION }).select('targetId taskCode next').lean(),
    HistoricalImportRecord.find({ action: ASSIGN_LEDGER_ACTION }).select('targetId personKey').lean(),
  ]);
  return buildPlan({ tasks, ledgerRecords, assignRecords });
}

// Every final rating that is NOT in the plan must come out of a commit byte-identical.
async function otherFinalFingerprints(plan) {
  const planned = new Set(plan.items.map((i) => i.code));
  const docs = await Task.find({ syntheticRating: { $exists: true } }).sort({ codeNumber: 1 }).lean();
  return docs.filter((d) => isFinalRating(d.syntheticRating) && !planned.has(d.codeNumber)).map((d) => `${d.codeNumber}:${fingerprint(d)}`);
}

async function runFix(args, now) {
  const mode = args.commit ? 'COMMIT' : 'DRY RUN';
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const meta = { mode, generatedAt: now.toISOString(), importBatch: IMPORT_BATCH };
  const plan = await loadPlan();

  console.log(`${mode}: ${plan.totals.toFix} final rating(s) to correct, ${plan.totals.alreadyCorrect} already correct, ${plan.totals.openFinals} open, ${plan.totals.anomalies} anomaly(ies)`);
  Object.entries(plan.byChange).forEach(([change, count]) => console.log(`  ${change}: ${count}`));
  plan.checks.forEach((c) => console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`));

  if (!args.commit) {
    writeReports(args, `final-rating-late-downgrade-dry-run-${stamp}`, renderPlanReport(plan, { meta }), { meta, plan });
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
    console.log('Nothing to correct. No backup taken, nothing written.');
    return;
  }

  const backupDir = backup('before-final-rating-late-downgrade');
  const before = { others: await otherFinalFingerprints(plan), taskUpdates: await TaskUpdate.countDocuments({}) };
  const applied = await applyPlan(plan, { importBatch: IMPORT_BATCH, now, log: (line) => console.log(line) });

  // Verification: every corrected task reads back with its new band and is still final; every
  // other final rating is byte-identical; no TaskUpdate was created.
  const problems = [];
  const fixedCodes = plan.items.map((i) => i.code).filter((code) => !applied.skipped.some((s) => s.code === code));
  const fixedDocs = await Task.find({ codeNumber: { $in: fixedCodes } }).lean();
  fixedDocs.forEach((d) => {
    const expected = computeFinalRating(d.syntheticRating.assumedPercent, d);
    if (d.performanceRating !== expected) problems.push(`${d.codeNumber}: band "${d.performanceRating}", expected "${expected}"`);
    if (!isFinalRating(d.syntheticRating)) problems.push(`${d.codeNumber}: no longer final`);
  });
  const othersAfter = await otherFinalFingerprints(plan);
  const verification = {
    allCorrected: problems.length === 0 && fixedDocs.length === fixedCodes.length,
    problems,
    othersUnchanged: JSON.stringify(othersAfter) === JSON.stringify(before.others),
    othersCount: othersAfter.length,
    taskUpdates: { before: before.taskUpdates, after: await TaskUpdate.countDocuments({}) },
  };
  const result = { ...applied, backupDir };
  console.log(`COMMIT RESULT: ${JSON.stringify({ fixed: applied.fixed, skipped: applied.skipped.length, allCorrected: verification.allCorrected, othersUnchanged: verification.othersUnchanged })}`);
  writeReports(args, `final-rating-late-downgrade-commit-${stamp}`, renderPlanReport(plan, { meta, result, verification }), { meta, plan, result, verification });
  if (!verification.allCorrected || !verification.othersUnchanged || verification.taskUpdates.before !== verification.taskUpdates.after) {
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
  console.log(`ROLLBACK ${mode}: ${records.length} active late-downgrade record(s) — ${JSON.stringify(counts)}`);

  if (!args.commit) {
    writeReports(args, `final-rating-late-downgrade-rollback-dry-run-${stamp}`, renderRollbackReport(rows, { meta }), { meta, rows });
    console.log('Rollback dry run complete — nothing was written to the database.');
    return;
  }
  if (records.length === 0) {
    console.log('Nothing to roll back. No backup taken, nothing written.');
    return;
  }
  const backupDir = backup('before-final-rating-late-downgrade-rollback');
  const rolledBack = await rollbackAll({ now, log: (line) => console.log(line) });
  const result = { ...rolledBack, backupDir };
  console.log(`ROLLBACK RESULT: ${JSON.stringify({ restored: result.restored, ledgerOnly: result.ledgerOnly, skipped: result.skipped.length })}`);
  writeReports(args, `final-rating-late-downgrade-rollback-commit-${stamp}`, renderRollbackReport(rows, { meta, result }), { meta, rows, result });
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
