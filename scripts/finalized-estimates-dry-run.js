// READ-ONLY review: which synthetic ("تخمینی") ratings the app will treat as FINAL once the
// "final estimate" change is deployed — read from the existing data alone, with no migration — and
// anything that does not fit the rule cleanly. Run it, and review its output, BEFORE deploying the
// backend.
//
//   node scripts/finalized-estimates-dry-run.js          (human-readable report)
//   node scripts/finalized-estimates-dry-run.js --json   (the same, as JSON)
//
// It never writes: find-only queries on lean documents; Mongoose's automatic index building and
// collection creation are switched off before any model is compiled (they would be writes); there
// is no write path in this file at all; and it prints to stdout only — no report file is written.
// It never prints the connection string or any credential (only the database name). The lists are
// explained in scripts/finalized-estimates/classify.js.
const mongoose = require('mongoose');

// Must run before any model is compiled: otherwise Mongoose would auto-create collections and
// auto-build indexes on connect — database writes, which this script must never make.
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const { connectDB } = require('../src/config/db');
const Task = require('../src/models/Task');
const HistoricalImportRecord = require('../src/models/HistoricalImportRecord');
const ActivityEvent = require('../src/models/ActivityEvent');
const { ACTIVITY_TYPES } = require('../src/utils/activityTypes');
const { ASSIGN_LEDGER_ACTION } = require('../src/utils/syntheticRating');
const { classify } = require('./finalized-estimates/classify');

const LIST_TITLES = {
  becomesFinal: '1. Becomes FINAL — no badge, counted as a real rating, the edit action disabled',
  editedThenRemoved: '2. Edited by an admin, then removed — unrated now; nothing changes (for information)',
  editedThenReplacedByReal: '3. Edited by an admin, then replaced by a real rating — nothing changes (for information)',
  ambiguous: '4. AMBIGUOUS — the rule cannot classify these with confidence; please review each one',
  activityWithoutHistory: '5. Activity-log edits with no matching admin edit in the task history',
};

function parseArgs(argv) {
  const args = { json: false };
  argv.forEach((arg) => {
    if (arg === '--json') args.json = true;
    else throw new Error(`Unknown argument: ${arg} (this script only reads; it has no write options)`);
  });
  return args;
}

function printList(key, rows) {
  console.log(`\n${LIST_TITLES[key]} — ${rows.length}`);
  if (!rows.length) {
    console.log('   (none)');
    return;
  }
  rows.forEach((row) => {
    const { code, ...rest } = row;
    const detail = Object.entries(rest)
      .map(([name, value]) => `${name}=${Array.isArray(value) ? value.join(' | ') : value}`)
      .join('  ');
    console.log(`   ${code}  ${detail}`);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await connectDB();
  try {
    const [tasks, assignRecords, activityEvents] = await Promise.all([
      Task.find({ syntheticRating: { $exists: true } })
        .select('codeNumber status completionPercent performanceRating syntheticRating')
        .lean(),
      HistoricalImportRecord.find({ action: ASSIGN_LEDGER_ACTION }).select('targetId taskCode next').lean(),
      ActivityEvent.find({ type: ACTIVITY_TYPES.SYNTHETIC_RATING_EDITED }).select('user at taskId metadata').lean(),
    ]);
    const { lists, totals } = classify({ tasks, assignRecords, activityEvents });

    if (args.json) {
      console.log(JSON.stringify({ database: mongoose.connection.name, generatedAt: new Date().toISOString(), totals, lists }, null, 2));
      return;
    }
    console.log(`Finalized-estimates DRY RUN — read only, nothing was written. Database: ${mongoose.connection.name}`);
    console.log(`Generated ${new Date().toISOString()}`);
    console.log(`\nTasks with a synthetic rating: ${totals.tasksWithSyntheticRating} · still estimates after the deploy: ${totals.stillEstimates}`);
    console.log(`Dashboard "تخمینی" count over all tasks: ${totals.estimatedRatingsShownBefore} now → ${totals.estimatedRatingsShownAfter} after the deploy`);
    Object.keys(LIST_TITLES).forEach((key) => printList(key, lists[key]));
    console.log('\nDry run complete — nothing was written to the database.');
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
