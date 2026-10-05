// Gives the historically-imported tasks that have no real rating a developer-assigned
// ("synthetic") one, clearly marked as such on the task (Task.syntheticRating) — without touching
// any real field of the task.
//
//   node scripts/assign-synthetic-ratings.js                      (dry run, default)
//   node scripts/assign-synthetic-ratings.js --commit             (real write)
//   node scripts/assign-synthetic-ratings.js --rollback           (rollback dry run)
//   node scripts/assign-synthetic-ratings.js --rollback --commit  (real rollback, from the ledger)
//
// Dry run: read-only database queries + a full Markdown/JSON report of everything that WOULD be
// written. --commit additionally requires every check to pass and a successful mongodump backup
// taken first. Reuses the historical import's conventions and its HistoricalImportRecord ledger.
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
const { buildPlan, LEDGER_ACTION } = require('./synthetic-ratings/plan');
const { applyPlan, rollbackAll, planRollback, fingerprint } = require('./synthetic-ratings/commit');
const { renderAssignReport, renderRollbackReport, findRatingReferences } = require('./synthetic-ratings/report');

const IMPORT_BATCH = 'synthetic-rating-v1';
const ASSIGNED_BY = 'system:script';
const REASON = 'Developer-assigned synthetic rating for a historically-imported task that had no real rating. Not a real performance rating.';

// Never touched, whatever its state: the live test task.
const NEVER_TOUCH_CODES = ['260912'];
// The tasks that already carry a REAL rating — the plan refuses to run unless it finds exactly these.
const EXPECTED_REAL_RATED = 13;
// Stay unrated ('-') on purpose, and are never written: closed as handovers — the work moved to
// someone else — which the historical-import review (HANDOVER_DECISIONS, 2026-10-01) recorded as
// "reassigned, no rating". Decided 2026-10-05: they get no synthetic rating either. The plan fails
// its checks unless each of these is present and still unrated.
const HANDOVER_REASON = 'closed as a handover ("reassigned") — left unrated by the import review, and gets no synthetic rating';
const EXCLUDED_CODES = {
  '250104': HANDOVER_REASON,
  '251009': HANDOVER_REASON,
  '260106': HANDOVER_REASON,
  '260108': HANDOVER_REASON,
};
// What the writer refuses outright, whatever a plan says.
const PROTECTED_CODES = [...NEVER_TOUCH_CODES, ...Object.keys(EXCLUDED_CODES)];
// The three target sets. Each is resolved by query at run time and must match its expected count
// exactly, or the script aborts and prints what it found. (Closed: 83 unrated minus the 4 above.)
const GROUPS = [
  { key: 'closedUnrated', label: 'closed, unrated', status: 'closed', assumedPercent: 80, expectedCount: 79 },
  { key: 'pending', label: 'pending (overdue), unrated', status: 'pending', assumedPercent: 40, expectedCount: 52 },
  { key: 'ongoing', label: 'ongoing, unrated', status: 'ongoing', assumedPercent: 70, expectedCount: 3 },
];

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REFERENCE_ROOTS = [
  ['backend/src', path.join(REPO_ROOT, 'backend', 'src')],
  ['backend/scripts', path.join(REPO_ROOT, 'backend', 'scripts')],
  ['frontend/src', path.join(REPO_ROOT, 'frontend', 'src')],
];

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

async function loadPlan(now) {
  const [tasks, importRecords, ratingRecords] = await Promise.all([
    Task.find({}).sort({ codeNumber: 1 }).lean(),
    HistoricalImportRecord.find({ kind: 'task' }).select('targetId taskCode personKey flags').lean(),
    HistoricalImportRecord.find({ action: LEDGER_ACTION }).select('targetId taskCode next').lean(),
  ]);
  return buildPlan({
    tasks,
    importRecords,
    ratingRecords,
    config: {
      groups: GROUPS,
      neverTouchCodes: NEVER_TOUCH_CODES,
      excludedCodes: EXCLUDED_CODES,
      expectedRealRated: EXPECTED_REAL_RATED,
      assignedBy: ASSIGNED_BY,
      reason: REASON,
    },
    now,
  });
}

// The tasks that must come out of a commit byte-identical: the really-rated ones, the never-touch
// list and the excluded handover tasks.
async function protectedFingerprints(plan) {
  const codes = [...plan.realRated, ...plan.neverTouched, ...plan.excluded].map((t) => t.code);
  const docs = await Task.find({ codeNumber: { $in: codes } }).sort({ codeNumber: 1 }).lean();
  return docs.map((d) => `${d.codeNumber}:${fingerprint(d)}`);
}

async function runAssign(args, now) {
  const mode = args.commit ? 'COMMIT' : 'DRY RUN';
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const meta = { mode, generatedAt: now.toISOString(), importBatch: IMPORT_BATCH, assignedBy: ASSIGNED_BY };
  const references = findRatingReferences(REFERENCE_ROOTS);
  const plan = await loadPlan(now);

  console.log(`${mode}: ${plan.totals.toAssign} task(s) to assign, ${plan.totals.alreadySynthetic} already synthetic, ${plan.totals.tasks} tasks in the database`);
  Object.values(plan.groups).forEach((g) =>
    console.log(`  ${g.label}: ${g.toAssign.length} to assign → ${g.rating} (assumed ${g.assumedPercent}%), ${g.alreadySynthetic.length} already synthetic, expected ${g.expectedCount}`)
  );
  plan.checks.forEach((c) => console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`));
  console.log(`Excluded (stay unrated): ${plan.excluded.map((t) => t.code).join(', ') || 'none'}`);

  if (!args.commit) {
    writeReports(args, `synthetic-ratings-dry-run-${stamp}`, renderAssignReport(plan, { meta, references }), { meta, checks: plan.checks, plan, references });
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
    console.log('Nothing to assign — every target task is already synthetic. No backup taken, nothing written.');
    return;
  }

  const backupDir = backup('before-synthetic-ratings');
  const before = {
    protectedDocs: await protectedFingerprints(plan),
    taskUpdates: await TaskUpdate.countDocuments({}),
    notifications: await Notification.countDocuments({}),
  };

  const applied = await applyPlan(plan, { importBatch: IMPORT_BATCH, neverTouchCodes: PROTECTED_CODES, log: (line) => console.log(line) });

  const afterDocs = await protectedFingerprints(plan);
  const protectedCheck = {
    protectedCount: afterDocs.length,
    protectedUnchanged: JSON.stringify(afterDocs) === JSON.stringify(before.protectedDocs),
    taskUpdates: { before: before.taskUpdates, after: await TaskUpdate.countDocuments({}) },
    notifications: { before: before.notifications, after: await Notification.countDocuments({}) },
  };
  const result = { ...applied, backupDir };
  console.log(`COMMIT RESULT: ${JSON.stringify({ assigned: applied.assigned, skipped: applied.skipped.length, protectedUnchanged: protectedCheck.protectedUnchanged })}`);
  writeReports(args, `synthetic-ratings-commit-${stamp}`, renderAssignReport(plan, { meta, references, result, protectedCheck }), {
    meta,
    checks: plan.checks,
    plan,
    references,
    result,
    protectedCheck,
  });
  if (!protectedCheck.protectedUnchanged || protectedCheck.taskUpdates.before !== protectedCheck.taskUpdates.after) {
    throw new Error('Post-commit verification failed: a protected task or the TaskUpdate collection changed during the run (see the report).');
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
  console.log(`ROLLBACK ${mode}: ${records.length} active synthetic-rating record(s) — ${JSON.stringify(counts)}`);

  if (!args.commit) {
    writeReports(args, `synthetic-ratings-rollback-dry-run-${stamp}`, renderRollbackReport(rows, { meta }), { meta, rows });
    console.log('Rollback dry run complete — nothing was written to the database.');
    return;
  }
  if (records.length === 0) {
    console.log('Nothing to roll back. No backup taken, nothing written.');
    return;
  }

  const backupDir = backup('before-synthetic-ratings-rollback');
  const rolledBack = await rollbackAll({ now, log: (line) => console.log(line) });
  const result = { ...rolledBack, backupDir };
  console.log(`ROLLBACK RESULT: ${JSON.stringify({ restored: result.restored, markerOnly: result.markerOnly, ledgerOnly: result.ledgerOnly, skipped: result.skipped.length })}`);
  writeReports(args, `synthetic-ratings-rollback-commit-${stamp}`, renderRollbackReport(rows, { meta, result }), { meta, rows, result });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await connectDB();
  try {
    const now = new Date();
    if (args.rollback) await runRollback(args, now);
    else await runAssign(args, now);
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
