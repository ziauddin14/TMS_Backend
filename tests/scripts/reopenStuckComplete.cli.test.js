const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const mongoose = require('mongoose');

// Both CLIs, end to end, against a throwaway database on the in-memory test server:
// - scripts/stuck-complete-dry-run.js — read only, stdout only;
// - scripts/reopen-stuck-complete.js in its default DRY RUN mode (and the rollback dry run) — reports
//   what --commit would do and writes its report files.
// Each leaves the database exactly as it found it — no document, index or collection created or
// changed — and never prints the connection string. (--commit itself needs mongodump for its
// backup; the writer and the rollback are tested directly in reopenStuckComplete.test.js.)
const REVIEW = path.resolve(__dirname, '../../scripts/stuck-complete-dry-run.js');
const FIX = path.resolve(__dirname, '../../scripts/reopen-stuck-complete.js');
const dbName = `reopencli_${Date.now()}`;
const uri = process.env.MONGO_TEST_URI.replace(/\/(\?|$)/, `/${dbName}$1`);
const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-reopen-stuck-'));
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
let conn;

beforeAll(async () => {
  conn = await mongoose.createConnection(uri).asPromise();
  const user = new mongoose.Types.ObjectId();
  const task = (code, extra) => ({
    _id: new mongoose.Types.ObjectId(),
    codeNumber: code,
    title: `title ${code}`,
    assignees: [user],
    responsibility: 'R',
    deadline: daysAgo(2),
    createdBy: user,
    lastUpdateAt: daysAgo(1),
    ...extra,
  });
  const stuck = task('261006', { status: 'complete', completionPercent: 0, timeStatus: { type: 'late', days: 1 }, performanceRating: 'weak' });
  const normal = task('261013', { status: 'complete', completionPercent: 100, lastUpdateAt: daysAgo(3), timeStatus: { type: 'early', days: 1 }, performanceRating: 'excellent' });
  await conn.db.collection('tasks').insertMany([stuck, normal]);
  await conn.db.collection('taskupdates').insertMany([
    { taskId: stuck._id, updatedBy: user, description: 'x', completionPercent: 100, createdAt: daysAgo(3) },
    { taskId: stuck._id, updatedBy: user, description: 'x', completionPercent: 0, createdAt: daysAgo(1) },
    { taskId: normal._id, updatedBy: user, description: 'x', completionPercent: 100, createdAt: daysAgo(3) },
  ]);
});
afterAll(async () => {
  await conn.dropDatabase();
  await conn.close();
  fs.rmSync(reportDir, { recursive: true, force: true });
});

function run(script, args = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { ...process.env, NODE_ENV: 'test', MONGODB_URI: uri }, timeout: 60000 }, (error, stdout, stderr) =>
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

const hidesTheConnection = (stdout) => !stdout.includes('mongodb://') && !stdout.includes(uri.split('/')[2]);

describe('scripts/stuck-complete-dry-run.js', () => {
  it('lists the stuck task, writes nothing at all, and never prints the connection string', async () => {
    const before = await stateOfDatabase();

    const { code, stdout } = await run(REVIEW);

    expect(code).toBe(0);
    expect(stdout).toContain('read only, nothing was written');
    expect(stdout).toMatch(/A\. Stuck: complete below 100%[^\n]*— 1\n\s+261006 {2}0% /);
    expect(stdout).toContain('complete→pending');
    expect(stdout).toContain('Totals: to reopen 1 (pending: 1) · anomalies 0');
    expect(stdout).not.toContain('title 261006'); // codes only
    expect(hidesTheConnection(stdout)).toBe(true);
    expect(await stateOfDatabase()).toEqual(before);
  });

  it('--json prints the same as JSON; an unknown argument is refused before connecting', async () => {
    const before = await stateOfDatabase();
    const { code, stdout } = await run(REVIEW, ['--json']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout.slice(stdout.indexOf('{')));
    expect(plan.items.map((i) => i.code)).toEqual(['261006']);
    expect(plan.totals).toMatchObject({ toRepair: 1, anomalies: 0 });
    expect(await stateOfDatabase()).toEqual(before);

    const refused = await run(REVIEW, ['--commit']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('this script only reads');
  });
});

describe('scripts/reopen-stuck-complete.js — dry run', () => {
  it('reports what --commit would reopen, writes its report files, and writes nothing to the database', async () => {
    const before = await stateOfDatabase();

    const { code, stdout } = await run(FIX, ['--report-dir', reportDir]);

    expect(code).toBe(0);
    expect(stdout).toContain('DRY RUN: 1 stuck task(s) to reopen, 0 anomaly(ies), 0 reopened by an earlier run');
    expect(stdout).toContain('→ pending: 1');
    expect(stdout).toContain('Dry run complete — nothing was written to the database.');
    expect(hidesTheConnection(stdout)).toBe(true);
    expect(await stateOfDatabase()).toEqual(before);
    const reports = fs.readdirSync(reportDir).filter((f) => f.startsWith('reopen-stuck-complete-dry-run-'));
    expect(reports.map((f) => path.extname(f)).sort()).toEqual(['.json', '.md']);
    const md = fs.readFileSync(path.join(reportDir, reports.find((f) => f.endsWith('.md'))), 'utf8');
    expect(md).toMatch(/\| 261006 \| 0% \|[^\n]*\| complete → pending \|/);
    expect(md).not.toContain('261013'); // completed normally: not touched, not listed
    expect(md).not.toContain('title 261006');
  });

  it('the rollback dry run reads the ledger and writes nothing; an unknown argument is refused', async () => {
    const before = await stateOfDatabase();
    const rollback = await run(FIX, ['--rollback', '--report-dir', reportDir]);
    expect(rollback.code).toBe(0);
    expect(rollback.stdout).toContain('ROLLBACK DRY RUN: 0 active reopen record(s)');
    expect(await stateOfDatabase()).toEqual(before);

    const refused = await run(FIX, ['--force']);
    expect(refused.code).not.toBe(0);
  });
});
