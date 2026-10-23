const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const mongoose = require('mongoose');

// The dry-run CLI end to end, against a throwaway database on the in-memory test server: it reads
// and reports, and leaves the database exactly as it found it — no document, no index, no
// collection created or changed — and never prints the connection string.
const SCRIPT = path.resolve(__dirname, '../../scripts/finalized-estimates-dry-run.js');
const dbName = `dryrun_cli_${Date.now()}`;
const uri = process.env.MONGO_TEST_URI.replace(/\/(\?|$)/, `/${dbName}$1`);
let conn;

beforeAll(async () => {
  conn = await mongoose.createConnection(uri).asPromise();
});
afterAll(async () => {
  await conn.dropDatabase();
  await conn.close();
});

function run(args = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, NODE_ENV: 'test', MONGODB_URI: uri }, timeout: 60000 }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })
    );
  });
}

// Every collection, its indexes and a hash of every document.
async function stateOfDatabase() {
  const collections = (await conn.db.listCollections().toArray()).map((c) => c.name).sort();
  const state = {};
  for (const name of collections) {
    // eslint-disable-next-line no-await-in-loop
    const docs = await conn.db.collection(name).find({}).sort({ _id: 1 }).toArray();
    // eslint-disable-next-line no-await-in-loop
    const indexes = await conn.db.collection(name).indexes();
    state[name] = {
      docs: crypto.createHash('sha256').update(mongoose.mongo.BSON.EJSON.stringify(docs, { relaxed: false })).digest('hex'),
      indexes: indexes.map((i) => i.name).sort(),
    };
  }
  return { collections, state };
}

describe('scripts/finalized-estimates-dry-run.js', () => {
  it('reports the lists, writes nothing at all, and never prints the connection string', async () => {
    const admin = new mongoose.Types.ObjectId();
    const at = new Date('2026-10-05T00:00:00.000Z');
    const script = { at, by: 'system:script', fromPercent: null, toPercent: 80, fromRating: '-', toRating: 'good', note: 'initial synthetic rating' };
    const base = (code, extra) => ({ codeNumber: code, title: code, status: 'closed', completionPercent: 0, performanceRating: 'good', ...extra });
    const tasks = [
      base('250301', { syntheticRating: { isSynthetic: true, assumedPercent: 80, assignedAt: at, assignedBy: 'system:script', history: [script] } }),
      base('250302', {
        performanceRating: 'excellent',
        timeStatus: { type: 'late', days: 117 }, // completed late: under the late rule it would be good
        syntheticRating: { isSynthetic: true, assumedPercent: 95, assignedAt: at, assignedBy: 'system:script', history: [script, { at: new Date('2026-10-12T00:00:00.000Z'), by: admin, fromPercent: 80, toPercent: 95, fromRating: 'good', toRating: 'excellent', note: null }] },
      }),
      base('250303', { performanceRating: 'weak' }),
    ];
    const { insertedIds } = await conn.db.collection('tasks').insertMany(tasks);
    await conn.db.collection('historicalimportrecords').insertMany(
      [0, 1].map((i) => ({ action: 'synthetic-rating', kind: 'syntheticRating', targetId: insertedIds[i], taskCode: tasks[i].codeNumber, next: { assumedPercent: 80, performanceRating: 'good' } }))
    );
    // No activityevents collection at all: the script must not create it.
    const before = await stateOfDatabase();

    const { code, stdout } = await run();

    expect(code).toBe(0);
    expect(stdout).toContain('read only, nothing was written');
    expect(stdout).toMatch(/1\. Becomes FINAL[^\n]*— 1\n\s+250302 /);
    expect(stdout).toContain('Dashboard "تخمینی" count over all tasks: 2 now → 1 after the deploy');
    expect(stdout).toMatch(/6\. Final ratings whose band would change[^\n]*— 1\n\s+250302 {2}status=closed {2}assumedPercent=95 {2}currentBand=excellent {2}newBand=good {2}late=true {2}daysLate=117/);
    expect(stdout).toContain('Band changes under the late rule (from → to): excellent→good: 1');
    expect(stdout).not.toContain('mongodb://');
    expect(stdout).not.toContain(uri.split('/')[2]); // host:port
    expect(await stateOfDatabase()).toEqual(before);
    expect(before.collections).not.toContain('activityevents');
  });

  // Reads the data seeded by the case above (same throwaway database, run in order).
  it('--json prints the same as JSON; an unknown argument is refused before connecting', async () => {
    const json = await run(['--json']);
    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout.slice(json.stdout.indexOf('{\n')));
    expect(report.database).toBe(dbName);
    expect(report.lists.becomesFinal.map((row) => row.code)).toEqual(['250302']);
    expect(report.totals).toMatchObject({ tasksWithSyntheticRating: 2, stillEstimates: 1 });

    const refused = await run(['--commit']);
    expect(refused.code).not.toBe(0);
  });
});
