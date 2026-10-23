const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const mongoose = require('mongoose');

// The fix script's CLI, end to end, in its default DRY RUN mode (and the rollback dry run), against a
// throwaway database on the in-memory test server: it reports what --commit would do, writes its
// report files, and leaves the database exactly as it found it — no document, index or collection
// created or changed — and never prints the connection string. (--commit itself needs mongodump for
// its backup; the writer and the rollback are tested directly in finalRatingLateDowngrade.test.js.)
const SCRIPT = path.resolve(__dirname, '../../scripts/fix-final-rating-late-downgrade.js');
const dbName = `fixcli_${Date.now()}`;
const uri = process.env.MONGO_TEST_URI.replace(/\/(\?|$)/, `/${dbName}$1`);
const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-fix-final-'));
let conn;

beforeAll(async () => {
  conn = await mongoose.createConnection(uri).asPromise();
});
afterAll(async () => {
  await conn.dropDatabase();
  await conn.close();
  fs.rmSync(reportDir, { recursive: true, force: true });
});

function run(args = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, NODE_ENV: 'test', MONGODB_URI: uri }, timeout: 60000 }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })
    );
  });
}

async function stateOfDatabase() {
  const collections = (await conn.db.listCollections().toArray()).map((c) => c.name).sort();
  const state = {};
  for (const name of collections) {
    // eslint-disable-next-line no-await-in-loop
    const docs = await conn.db.collection(name).find({}).sort({ _id: 1 }).toArray();
    // eslint-disable-next-line no-await-in-loop
    const indexes = await conn.db.collection(name).indexes();
    state[name] = { docs: crypto.createHash('sha256').update(mongoose.mongo.BSON.EJSON.stringify(docs, { relaxed: false })).digest('hex'), indexes: indexes.map((i) => i.name).sort() };
  }
  return { collections, state };
}

describe('scripts/fix-final-rating-late-downgrade.js — dry run', () => {
  it('reports what --commit would correct, writes its report files, and writes nothing to the database', async () => {
    const admin = new mongoose.Types.ObjectId();
    const at = new Date('2026-10-05T00:00:00.000Z');
    const script = { at, by: 'system:script', fromPercent: null, toPercent: 80, fromRating: '-', toRating: 'good', note: 'initial synthetic rating' };
    const final90 = {
      codeNumber: '250401',
      title: 'late final',
      status: 'closed',
      completionPercent: 0,
      timeStatus: { type: 'late', days: 117 },
      performanceRating: 'excellent',
      syntheticRating: { isSynthetic: true, assumedPercent: 90, assignedAt: at, assignedBy: 'system:script', history: [script, { at, by: admin, fromPercent: 80, toPercent: 90, fromRating: 'good', toRating: 'excellent', note: null }] },
    };
    const estimate = { ...final90, codeNumber: '250402', title: 'late estimate', performanceRating: 'good', syntheticRating: { isSynthetic: true, assumedPercent: 80, assignedAt: at, assignedBy: 'system:script', history: [script] } };
    await conn.db.collection('tasks').insertMany([final90, estimate]);
    const before = await stateOfDatabase();

    const { code, stdout } = await run(['--report-dir', reportDir]);

    expect(code).toBe(0);
    expect(stdout).toContain('DRY RUN: 1 final rating(s) to correct, 0 already correct, 0 open, 0 anomaly(ies)');
    expect(stdout).toContain('excellent→good: 1');
    expect(stdout).toContain('Dry run complete — nothing was written to the database.');
    expect(stdout).not.toContain('mongodb://');
    expect(stdout).not.toContain(uri.split('/')[2]);
    expect(await stateOfDatabase()).toEqual(before);
    const reports = fs.readdirSync(reportDir).filter((f) => f.startsWith('final-rating-late-downgrade-dry-run-'));
    expect(reports.map((f) => path.extname(f)).sort()).toEqual(['.json', '.md']);
    const md = fs.readFileSync(path.join(reportDir, reports.find((f) => f.endsWith('.md'))), 'utf8');
    expect(md).toContain('| 250401 | closed | 90% | excellent (ممتاز) | good (بہتر) | 117 |');
    expect(md).not.toContain('250402'); // a still-estimated rating is never touched
  });

  it('the rollback dry run reads the ledger and writes nothing; an unknown argument is refused', async () => {
    const before = await stateOfDatabase();
    const rollback = await run(['--rollback', '--report-dir', reportDir]);
    expect(rollback.code).toBe(0);
    expect(rollback.stdout).toContain('ROLLBACK DRY RUN: 0 active late-downgrade record(s)');
    expect(await stateOfDatabase()).toEqual(before);

    const refused = await run(['--force']);
    expect(refused.code).not.toBe(0);
  });
});
