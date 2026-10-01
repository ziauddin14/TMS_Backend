// One-off import of the historical "Follow-up Karkardagi" records (4 Zimmedaran) into Task /
// TaskUpdate, with full provenance in HistoricalImportRecord.
//
//   node scripts/import-historical-followup.js --file <historical_followup_data.json>            (dry run, default)
//   node scripts/import-historical-followup.js --file <...> --commit                            (real write)
//
// Dry run: read-only database checks + a full Markdown/JSON report of everything that WOULD be
// created. --commit additionally requires: every preflight check passing, every handover-closure
// decision recorded below, and a successful mongodump backup taken first.
const mongoose = require('mongoose');

// Must run before any model is compiled (plan.js/commit.js load them): otherwise Mongoose would
// auto-create the new ledger collection and auto-build indexes on connect — database writes,
// which a dry run must never make. The --commit path creates the ledger collection explicitly.
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const env = require('../src/config/env');
const { connectDB } = require('../src/config/db');
const User = require('../src/models/User');
const Task = require('../src/models/Task');
const HistoricalImportRecord = require('../src/models/HistoricalImportRecord');
const { buildPlan } = require('./historical-import/plan');
const { commitPlan } = require('./historical-import/commit');
const { renderMarkdown } = require('./historical-import/report');

const IMPORT_BATCH = 'historical-followup-v1';
const EXPECTED_TOTALS = { tasks: 151, updates: 410 };

// ---- Confirmed decisions (Phase B brief) ----
const USER_MAP = {
  daktar_abdul_qayyum: '6abcc4920361a9862b3cdde5',
  abdul_rauf: '6a928b20c7bb460029e8c063',
  umar_khan: '6abcc4ac0361a9862b3cddec',
  imran_sarwar: '6abcc4c20361a9862b3cddf3',
};
// Every "admin" speaker and every Task.createdBy — the رکن شوری user.
const ADMIN_USER_ID = '6aa9356bbb6ebff6a97e51ed';
const EXPECTED_ADMIN_RESPONSIBILITY = 'رکن شوری';
// Historical department of these tasks — not Abdul Rauf's current, unrelated role.
const RESPONSIBILITY_OVERRIDES = { abdul_rauf: 'نگران مجلس عطیات بکس' };
// The same task appears in both files (a handover); it becomes ONE task owned by Umar Khan.
const MERGES = { '260410': { keep: 'umar_khan', drop: ['abdul_rauf'] } };
const STATUS_OVERRIDES = {
  '260410': {
    status: 'open',
    reason:
      'confirmed "not a completion" — handed over to Umar Khan (current owner). Note: its source Close column (8-Jun-26) would otherwise mark it closed under the general rule.',
  },
};

// ---- Pending human review — --commit refuses to run until every decision is filled in ----
// Effect: 'completed' keeps the normal rating rule; 'reassigned' forces rating '-'.
const HANDOVER_CASES = {
  'daktar_abdul_qayyum:250104': {
    bestGuess: 'reassigned',
    rationale: 'closed on his side "because Haji Abdul Rauf bhai will do it" — the work moved to someone else.',
  },
  'abdul_rauf:251009': {
    bestGuess: 'reassigned',
    rationale: 'first update says Imran Sarwar bhai is handling it; then closed "from your side".',
  },
  'abdul_rauf:251102': {
    bestGuess: 'reassigned',
    rationale:
      'first update says Arman bhai will do it — but the admin explicitly records "0 فیصد کارکردگی", which may be meant to count against him.',
  },
  'abdul_rauf:251022': {
    bestGuess: 'completed',
    rationale: '"closed from your side with delay" after an in-progress update — reads as his own late completion.',
  },
  'abdul_rauf:260106': {
    bestGuess: 'completed',
    rationale: 'closed on his side with an instruction to hand the points to Dr. Abdul Qayyum to carry forward — his part reads as done.',
  },
  'abdul_rauf:260108': {
    bestGuess: 'reassigned',
    rationale: '"being closed from your plate" right after a still-pending status check — reads as withdrawn, not completed.',
  },
  'abdul_rauf:260502': {
    bestGuess: 'completed',
    rationale: '"since the work is complete on your side, we close it".',
  },
};
// Recorded 2026-10-01 from the reviewer's reading of each quoted closing line.
const HANDOVER_DECISIONS = {
  'daktar_abdul_qayyum:250104': 'reassigned', // "…کیونکہ یہ حاجی عبدالرؤف بھائی کریں گے" — someone else took it over
  'abdul_rauf:251009': 'reassigned', // Imran Sarwar bhai was handling it before closure
  'abdul_rauf:251102': 'completed', // admin deliberately records "0 فیصد کارکردگی" against him
  'abdul_rauf:251022': 'completed', // no reassignment language; his own late completion
  'abdul_rauf:260106': 'reassigned', // points handed to Dr. Abdul Qayyum to carry forward
  'abdul_rauf:260108': 'reassigned', // taken off his plate while still unresolved
  'abdul_rauf:260502': 'completed', // "آپ کی طرف سے کام مکمل ہوچکا ہے تو اسے کلوز کر دیتے ہیں"
};

function parseArgs(argv) {
  const args = { commit: false, file: null, reportDir: path.resolve(__dirname, '..', 'import-reports') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--commit') args.commit = true;
    else if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--report-dir') args.reportDir = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.file) throw new Error('--file <path to historical_followup_data.json> is required');
  return args;
}

async function runPreflight(plannedCodes) {
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok, detail });

  const ids = [...Object.values(USER_MAP), ADMIN_USER_ID];
  const users = await User.find({ _id: { $in: ids } }).select('name role isActive responsibility').lean();
  const byId = Object.fromEntries(users.map((u) => [String(u._id), u]));

  Object.entries(USER_MAP).forEach(([key, id]) => {
    const u = byId[id];
    check(`${key} → ${id}`, Boolean(u && u.isActive && u.role === 'user'), u ? `${u.name}, role ${u.role}, active ${u.isActive}` : 'NOT FOUND');
  });
  const admin = byId[ADMIN_USER_ID];
  check(
    `admin author / createdBy → ${ADMIN_USER_ID}`,
    Boolean(admin && admin.isActive && admin.role === 'admin' && admin.responsibility === EXPECTED_ADMIN_RESPONSIBILITY),
    admin ? `${admin.name}, role ${admin.role}, responsibility ${admin.responsibility}` : 'NOT FOUND'
  );

  const responsibilityByPerson = {};
  Object.entries(USER_MAP).forEach(([key, id]) => {
    responsibilityByPerson[key] = RESPONSIBILITY_OVERRIDES[key] || byId[id]?.responsibility;
  });

  const liveClashes = await Task.find({ codeNumber: { $in: plannedCodes } }).select('codeNumber').lean();
  const ledgered = await HistoricalImportRecord.find({ kind: 'task' }).select('taskCode').lean();
  const ledgeredCodes = new Set(ledgered.map((r) => r.taskCode));
  const unexplained = liveClashes.filter((t) => !ledgeredCodes.has(t.codeNumber)).map((t) => t.codeNumber);
  check('no live Task already uses a historical codeNumber', unexplained.length === 0, unexplained.length ? unexplained.join(', ') : `${liveClashes.length} matches, all from a previous run of this import`);
  check('import ledger', true, `${ledgered.length} task(s) already imported by a previous run (would be skipped)`);

  const userNames = Object.fromEntries(users.map((u) => [String(u._id), u.name]));
  return { checks, ok: checks.every((c) => c.ok), responsibilityByPerson, userNames };
}

function takeBackup() {
  const dir = path.resolve(__dirname, '..', 'import-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  // The URI (credentials) is passed as an argument but never printed.
  const result = spawnSync('mongodump', ['--uri', env.MONGODB_URI, '--out', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error(
      'mongodump not found on PATH (on Windows the MongoDB Database Tools installer does not add "C:\\Program Files\\MongoDB\\Tools\\100\\bin" to PATH) — refusing to commit without a backup.'
    );
  }
  if (result.status !== 0) {
    throw new Error(`mongodump failed (exit ${result.status}) — refusing to commit. ${String(result.stderr || '').slice(-500)}`);
  }
  return dir;
}

async function ensureLedgerCollection() {
  try {
    await HistoricalImportRecord.createCollection();
  } catch (err) {
    if (err.codeName !== 'NamespaceExists') throw err;
  }
  await HistoricalImportRecord.createIndexes();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.commit ? 'COMMIT' : 'DRY RUN';
  const data = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  const plannedCodes = [...new Set(Object.values(data).flatMap((p) => p.tasks.map((t) => t.code)))];

  await connectDB();
  try {
    const preflight = await runPreflight(plannedCodes);
    const now = new Date();
    const plan = buildPlan(data, {
      userMap: USER_MAP,
      adminUserId: ADMIN_USER_ID,
      responsibilityByPerson: preflight.responsibilityByPerson,
      merges: MERGES,
      statusOverrides: STATUS_OVERRIDES,
      handoverCases: HANDOVER_CASES,
      handoverDecisions: HANDOVER_DECISIONS,
      reminderDaysBefore: env.REMINDER_DAYS_BEFORE,
      now,
    });

    const totalsOk = plan.totals.tasks === EXPECTED_TOTALS.tasks && plan.totals.updates === EXPECTED_TOTALS.updates;
    preflight.checks.push({
      label: `plan totals = ${EXPECTED_TOTALS.tasks} Tasks / ${EXPECTED_TOTALS.updates} TaskUpdates`,
      ok: totalsOk,
      detail: `${plan.totals.tasks} / ${plan.totals.updates}`,
    });
    const undecided = Object.keys(HANDOVER_CASES).filter((k) => !['completed', 'reassigned'].includes(HANDOVER_DECISIONS[k]));
    preflight.checks.push({
      label: 'handover-closure decisions recorded',
      ok: undecided.length === 0,
      detail: undecided.length ? `${undecided.length} pending: ${undecided.join(', ')}` : 'all recorded',
    });

    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const meta = { mode, generatedAt: now.toISOString(), now: now.toISOString().slice(0, 10), sourceFile: path.basename(args.file), importBatch: IMPORT_BATCH };
    fs.mkdirSync(args.reportDir, { recursive: true });
    const base = path.join(args.reportDir, `historical-import-${args.commit ? 'commit' : 'dry-run'}-${stamp}`);
    fs.writeFileSync(`${base}.md`, renderMarkdown(plan, { meta, preflight, userNames: preflight.userNames }));
    fs.writeFileSync(`${base}.json`, JSON.stringify({ meta, preflight: preflight.checks, plan }, null, 2));

    console.log(`${mode}: ${plan.totals.tasks} Tasks / ${plan.totals.updates} TaskUpdates planned`);
    console.log(`Status: ${JSON.stringify(plan.totals.byStatus)} · Rating: ${JSON.stringify(plan.totals.byRating)}`);
    preflight.checks.forEach((c) => console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`));
    console.log(`Report: ${base}.md`);
    console.log(`Plan JSON: ${base}.json`);

    if (!args.commit) {
      console.log('Dry run complete — nothing was written to the database.');
      return;
    }

    if (!preflight.checks.every((c) => c.ok)) {
      throw new Error('Refusing to commit: one or more preflight checks failed (see above).');
    }
    const backupDir = takeBackup();
    console.log(`Backup written to ${backupDir}`);

    await ensureLedgerCollection();
    const result = await commitPlan(plan, { importBatch: IMPORT_BATCH, log: (line) => console.log(line) });
    console.log(`COMMIT RESULT: ${JSON.stringify(result)}`);
    if (result.conflicts.length) process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
