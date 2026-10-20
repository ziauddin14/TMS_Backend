const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const HistoricalImportRecord = require('../../src/models/HistoricalImportRecord');
const taskService = require('../../src/services/task.service');
const { isFinalRating } = require('../../src/utils/syntheticRating');
const { buildPlan, LEDGER_ACTION } = require('../../scripts/synthetic-ratings/plan');
const { applyPlan, rollbackAll, planRollback, fingerprint } = require('../../scripts/synthetic-ratings/commit');
const { renderAssignReport, renderRollbackReport } = require('../../scripts/synthetic-ratings/report');

// The synthetic-rating scripts and a FINAL rating (an admin's edit): the rollback never touches
// one — not the task, not its ledger record — and the assign plan lists it and never plans it.
beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

const NOW = new Date('2026-10-05T06:00:00.000Z');
const CONFIG = {
  groups: [
    { key: 'closedUnrated', label: 'closed, unrated', status: 'closed', assumedPercent: 80, expectedCount: 1 },
    { key: 'pending', label: 'pending, unrated', status: 'pending', assumedPercent: 40, expectedCount: 1 },
    { key: 'ongoing', label: 'ongoing, unrated', status: 'ongoing', assumedPercent: 70, expectedCount: 1 },
  ],
  neverTouchCodes: [],
  expectedRealRated: 0,
  assignedBy: 'system:script',
  reason: 'test reason',
};

async function seed() {
  const user = await User.create({ name: 'Z', email: `z${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'user' });
  const admin = await User.create({ name: 'A', email: `a${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'admin' });
  const base = (code, extra) => ({
    codeNumber: code,
    title: `کام ${code}`,
    assignees: [user._id],
    responsibility: 'R',
    deadline: new Date('2025-03-31T00:00:00.000Z'),
    createdBy: admin._id,
    createdAt: new Date('2025-01-10T00:00:00.000Z'),
    updatedAt: new Date('2025-03-20T00:00:00.000Z'),
    ...extra,
  });
  const docs = await Task.create(
    [
      base('250101', { status: 'closed', closedBy: admin._id, closedAt: new Date('2025-03-20T00:00:00.000Z'), timeStatus: { type: 'early', days: 11 } }),
      base('250102', { status: 'pending', completionPercent: 25, timeStatus: { type: 'overdue', days: 500 } }),
      base('250103', { status: 'ongoing', deadline: new Date('2026-12-31T00:00:00.000Z'), timeStatus: { type: 'remaining', days: 87 } }),
    ],
    { timestamps: false, ordered: true }
  );
  await HistoricalImportRecord.create(
    docs.map((d) => ({ importBatch: 'historical-followup-v1', sourceKey: `task:${d.codeNumber}`, kind: 'task', targetId: d._id, taskCode: d.codeNumber, personKey: 'alpha', flags: {} })),
    { ordered: true }
  );
  return { admin };
}

async function loadPlan() {
  const [tasks, importRecords, ratingRecords] = await Promise.all([
    Task.find({}).sort({ codeNumber: 1 }).lean(),
    HistoricalImportRecord.find({ kind: 'task' }).lean(),
    HistoricalImportRecord.find({ action: LEDGER_ACTION }).lean(),
  ]);
  return buildPlan({ tasks, importRecords, ratingRecords, config: CONFIG, now: NOW });
}
const byCode = async (code) => Task.findOne({ codeNumber: code }).lean();
const ledgerOf = async (code) => HistoricalImportRecord.find({ taskCode: code, kind: 'syntheticRating' }).sort({ action: 1 }).lean();
const snapshot = async (code) => ({ task: fingerprint(await byCode(code)), ledger: (await ledgerOf(code)).map((r) => fingerprint(r)) });

// Assigns all three, then: 250101 edited by an admin through the app (finalizedAt), 250102 edited
// BEFORE this change (only an admin entry in its history), 250103 left as an estimate.
async function assignAndFinalize() {
  const { admin } = await seed();
  await applyPlan(await loadPlan(), { importBatch: 'synthetic-rating-test', neverTouchCodes: [] });
  const t1 = await byCode('250101');
  await taskService.editSyntheticRating({ id: admin.id, role: 'admin' }, String(t1._id), { assumedPercent: 95 });
  await Task.collection.updateOne(
    { codeNumber: '250102' },
    {
      $set: { performanceRating: 'weak', 'syntheticRating.assumedPercent': 55 },
      $push: { 'syntheticRating.history': { at: new Date('2026-10-08T00:00:00.000Z'), by: admin._id, fromPercent: 40, toPercent: 55, fromRating: 'weak', toRating: 'weak', note: null } },
    }
  );
  return { admin };
}

describe('rollback and a final rating', () => {
  it('skips every final rating — new and from before this change — leaving the task and its ledger records byte-identical', async () => {
    await assignAndFinalize();
    const before = { a: await snapshot('250101'), b: await snapshot('250102') };

    const result = await rollbackAll({ now: new Date('2026-10-20T00:00:00.000Z') });

    expect(result).toMatchObject({ restored: 1, markerOnly: 0, ledgerOnly: 0 }); // 250103, the estimate
    expect(result.skipped.map((s) => s.code).sort()).toEqual(['250101', '250102']);
    result.skipped.forEach((s) => expect(s.reason).toMatch(/the rating is final/));
    expect(await snapshot('250101')).toEqual(before.a);
    expect(await snapshot('250102')).toEqual(before.b);
    expect((await byCode('250101')).syntheticRating).toMatchObject({ isSynthetic: true, assumedPercent: 95 });
    // The estimate was rolled back as before.
    expect((await byCode('250103')).syntheticRating).toBeUndefined();
  });

  it('an admin who sets the estimate back to the originally assigned percent still made it final — the rollback does not restore it', async () => {
    const { admin } = await seed();
    await applyPlan(await loadPlan(), { importBatch: 'synthetic-rating-test', neverTouchCodes: [] });
    const t3 = await byCode('250103');
    await taskService.editSyntheticRating({ id: admin.id, role: 'admin' }, String(t3._id), { assumedPercent: 70 }); // = the assigned 70%
    const after = await byCode('250103');
    expect(isFinalRating(after.syntheticRating)).toBe(true);
    const before = await snapshot('250103');

    const result = await rollbackAll({ now: new Date('2026-10-20T00:00:00.000Z') });

    expect(result.skipped.map((s) => s.code)).toEqual(['250103']);
    expect(await snapshot('250103')).toEqual(before);
    expect((await byCode('250103')).performanceRating).toBe('fair'); // not put back to "-"
  });

  it('the rollback dry run says so too, without writing anything', async () => {
    await assignAndFinalize();
    const records = await HistoricalImportRecord.find({ action: LEDGER_ACTION }).sort({ taskCode: 1 }).lean();
    const tasks = new Map((await Task.find({}).lean()).map((t) => [String(t._id), t]));

    const rows = records.map((r) => ({ code: r.taskCode, ...planRollback(r, tasks.get(String(r.targetId))) }));

    expect(rows.map((r) => [r.code, r.action])).toEqual([
      ['250101', 'skip-finalized'],
      ['250102', 'skip-finalized'],
      ['250103', 'restore'],
    ]);
    const report = renderRollbackReport(rows, { meta: { mode: 'DRY RUN', generatedAt: 'x' } });
    expect(report).toContain('skip-finalized: 2');
  });
});

describe('the assign plan and a final rating', () => {
  it('lists final ratings as "finalized by an admin", plans nothing for them, and still passes its checks', async () => {
    await assignAndFinalize();

    const plan = await loadPlan();

    expect(plan.ok).toBe(true);
    expect(plan.items).toHaveLength(0);
    expect(plan.groups.closedUnrated.finalizedByAdmin.map((t) => t.code)).toEqual(['250101']);
    expect(plan.groups.pending.finalizedByAdmin.map((t) => t.code)).toEqual(['250102']);
    expect(plan.groups.ongoing.alreadySynthetic.map((t) => t.code)).toEqual(['250103']);
    expect(plan.totals).toMatchObject({ toAssign: 0, alreadySynthetic: 1, finalizedByAdmin: 2 });

    const report = renderAssignReport(plan, { meta: { mode: 'DRY RUN', generatedAt: 'x', importBatch: 'b', assignedBy: 's' }, references: [] });
    expect(report).toContain('### Finalized by an admin — 2 task(s)');
    expect(report).toMatch(/\| 250101 \| closed, unrated \|/);
    expect(report).toContain('before this marker existed (from its history)'); // 250102
  });

  it('a re-run of the writer never re-assigns over a final rating', async () => {
    await assignAndFinalize();
    const before = await snapshot('250101');
    const result = await applyPlan(await loadPlan(), { importBatch: 'synthetic-rating-test', neverTouchCodes: [] });
    expect(result.assigned).toBe(0);
    expect(await snapshot('250101')).toEqual(before);
  });
});
