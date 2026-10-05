const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const TaskUpdate = require('../../src/models/TaskUpdate');
const Notification = require('../../src/models/Notification');
const HistoricalImportRecord = require('../../src/models/HistoricalImportRecord');
const taskService = require('../../src/services/task.service');
const { buildPlan, LEDGER_ACTION, LEDGER_ACTION_ROLLED_BACK } = require('../../scripts/synthetic-ratings/plan');
const { applyPlan, rollbackAll, planRollback, fingerprint } = require('../../scripts/synthetic-ratings/commit');

beforeAll(async () => connect());
afterEach(async () => {
  await clearDatabase();
  jest.restoreAllMocks();
});
afterAll(async () => closeDatabase());

const NOW = new Date('2026-10-05T06:00:00.000Z');
const NEVER_TOUCH = ['260912'];
const CONFIG = {
  groups: [
    { key: 'closedUnrated', label: 'closed, unrated', status: 'closed', assumedPercent: 80, expectedCount: 1 },
    { key: 'pending', label: 'pending, unrated', status: 'pending', assumedPercent: 40, expectedCount: 1 },
    { key: 'ongoing', label: 'ongoing, unrated', status: 'ongoing', assumedPercent: 70, expectedCount: 1 },
  ],
  neverTouchCodes: NEVER_TOUCH,
  expectedRealRated: 1,
  assignedBy: 'system:script',
  reason: 'test reason',
};

// Historical documents, written the way the import wrote them: explicit old timestamps.
async function seed() {
  const user = await User.create({ name: 'Z', email: `z${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'user' });
  const admin = await User.create({ name: 'A', email: `a${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'رکن شوری', role: 'admin' });
  const base = (code, extra) => ({
    codeNumber: code,
    title: `کام ${code}`,
    assignees: [user._id],
    responsibility: 'R',
    deadline: new Date('2025-03-31T00:00:00.000Z'),
    createdBy: admin._id,
    createdAt: new Date('2025-01-10T00:00:00.000Z'),
    updatedAt: new Date('2025-03-20T00:00:00.000Z'),
    lastUpdateAt: new Date('2025-03-20T00:00:00.000Z'),
    ...extra,
  });
  const docs = await Task.create(
    [
      base('250101', { status: 'closed', closedBy: admin._id, closedAt: new Date('2025-03-20T00:00:00.000Z'), timeStatus: { type: 'early', days: 11 } }),
      base('250102', { status: 'pending', completionPercent: 25, timeStatus: { type: 'overdue', days: 500 } }),
      base('250103', { status: 'ongoing', deadline: new Date('2026-12-31T00:00:00.000Z'), timeStatus: { type: 'remaining', days: 87 } }),
      base('250104', { status: 'closed', completionPercent: 56, performanceRating: 'weak', closedBy: admin._id, closedAt: new Date('2025-03-20T00:00:00.000Z'), timeStatus: { type: 'late', days: 3 } }),
      base('260912', { status: 'pending', completionPercent: 20, timeStatus: { type: 'overdue', days: 2 } }),
    ],
    { timestamps: false, ordered: true }
  );
  // Everything except the live test task came from the import.
  await HistoricalImportRecord.create(
    docs
      .filter((d) => d.codeNumber !== '260912')
      .map((d) => ({ importBatch: 'historical-followup-v1', sourceKey: `task:${d.codeNumber}`, kind: 'task', targetId: d._id, taskCode: d.codeNumber, personKey: 'alpha', flags: { ratingBasis: 'no_explicit_percent' } })),
    { ordered: true }
  );
  return { user, admin };
}

async function loadPlan() {
  const [tasks, importRecords, ratingRecords] = await Promise.all([
    Task.find({}).sort({ codeNumber: 1 }).lean(),
    HistoricalImportRecord.find({ kind: 'task' }).lean(),
    HistoricalImportRecord.find({ action: LEDGER_ACTION }).lean(),
  ]);
  return buildPlan({ tasks, importRecords, ratingRecords, config: CONFIG, now: NOW });
}
const apply = (plan) => applyPlan(plan, { importBatch: 'synthetic-rating-test', neverTouchCodes: NEVER_TOUCH });
const leanByCode = async () => Object.fromEntries((await Task.find({}).lean()).map((t) => [t.codeNumber, t]));

describe('synthetic ratings — applyPlan', () => {
  it('sets only performanceRating and syntheticRating — every other field, updatedAt included, is byte-identical', async () => {
    await seed();
    const before = await leanByCode();

    const result = await apply(await loadPlan());

    expect(result).toEqual({ assigned: 3, skipped: [] });
    const after = await leanByCode();
    ['250101', '250102', '250103'].forEach((code) => {
      expect(fingerprint(after[code], ['performanceRating', 'syntheticRating'])).toBe(fingerprint(before[code], ['performanceRating', 'syntheticRating']));
      expect(after[code].updatedAt.toISOString()).toBe('2025-03-20T00:00:00.000Z');
      expect(after[code].status).toBe(before[code].status);
      expect(after[code].completionPercent).toBe(before[code].completionPercent);
    });
    expect([after['250101'].performanceRating, after['250102'].performanceRating, after['250103'].performanceRating]).toEqual(['good', 'weak', 'fair']);
    expect(after['250102'].syntheticRating).toMatchObject({ isSynthetic: true, assumedPercent: 40, assignedBy: 'system:script', reason: 'test reason' });
    expect(after['250102'].syntheticRating.history).toEqual([
      expect.objectContaining({ fromPercent: null, toPercent: 40, fromRating: '-', toRating: 'weak', by: 'system:script' }),
    ]);
  });

  it('leaves the really-rated task and the never-touch task byte-identical, and creates no TaskUpdate or notification', async () => {
    await seed();
    const before = await leanByCode();

    await apply(await loadPlan());

    const after = await leanByCode();
    expect(fingerprint(after['250104'])).toBe(fingerprint(before['250104']));
    expect(fingerprint(after['260912'])).toBe(fingerprint(before['260912']));
    expect(after['260912'].syntheticRating).toBeUndefined();
    expect(await TaskUpdate.countDocuments({})).toBe(0);
    expect(await Notification.countDocuments({})).toBe(0);
  });

  it('writes one ledger record per task with the previous and the new values', async () => {
    await seed();
    const before = await leanByCode();

    await apply(await loadPlan());

    expect(await HistoricalImportRecord.countDocuments({ action: LEDGER_ACTION })).toBe(3);
    const record = await HistoricalImportRecord.findOne({ sourceKey: 'synthetic-rating:250102' }).lean();
    expect(record).toMatchObject({
      kind: 'syntheticRating',
      action: 'synthetic-rating',
      importBatch: 'synthetic-rating-test',
      taskCode: '250102',
      personKey: 'alpha',
      flags: { group: 'pending' },
      previous: { performanceRating: '-', hadPerformanceRatingField: true, syntheticRating: null, status: 'pending', completionPercent: 25, fingerprint: fingerprint(before['250102']) },
      next: { group: 'pending', performanceRating: 'weak', assumedPercent: 40 },
    });
    expect(String(record.targetId)).toBe(String(before['250102']._id));
    // The import's own records are untouched.
    expect(await HistoricalImportRecord.countDocuments({ kind: 'task' })).toBe(4);
  });

  it('is idempotent — a re-run assigns nothing and the plan still passes its checks', async () => {
    await seed();
    await apply(await loadPlan());
    const afterFirst = await leanByCode();

    const secondPlan = await loadPlan();
    const second = await apply(secondPlan);

    expect(secondPlan.ok).toBe(true);
    expect(secondPlan.items).toEqual([]);
    expect(second).toEqual({ assigned: 0, skipped: [] });
    const afterSecond = await leanByCode();
    Object.keys(afterFirst).forEach((code) => expect(fingerprint(afterSecond[code])).toBe(fingerprint(afterFirst[code])));
    expect(await HistoricalImportRecord.countDocuments({ action: LEDGER_ACTION })).toBe(3);
  });

  it('a re-run after the app has replaced a synthetic rating with a real one still passes its checks and leaves that task alone', async () => {
    const { admin } = await seed();
    await apply(await loadPlan());
    // The admin really closes the (synthetic, pending) task: the app's rule makes its rating real.
    const pending = await Task.findOne({ codeNumber: '250102' });
    await taskService.closeTask(admin, pending.id);
    const closed = await Task.findOne({ codeNumber: '250102' }).lean();
    expect(closed.syntheticRating.isSynthetic).toBe(false);

    const rerun = await loadPlan();
    const result = await apply(rerun);

    expect(rerun.ok).toBe(true);
    expect(rerun.groups.pending.replacedByReal.map((t) => t.code)).toEqual(['250102']);
    expect(rerun.realRated.map((t) => t.code)).toEqual(['250104']); // still only the import's own rated task
    expect(result).toEqual({ assigned: 0, skipped: [] });
    expect(fingerprint(await Task.findOne({ codeNumber: '250102' }).lean())).toBe(fingerprint(closed));
  });

  it('skips a task that changed between planning and writing, instead of overwriting it', async () => {
    const { admin } = await seed();
    const plan = await loadPlan();
    // The admin really closes the ongoing task after the plan was built: it now has a real rating.
    const ongoing = await Task.findOne({ codeNumber: '250103' });
    await taskService.closeTask(admin, ongoing.id);

    const result = await apply(plan);

    expect(result.assigned).toBe(2);
    expect(result.skipped).toEqual([{ code: '250103', reason: 'now has a real rating (weak)' }]);
    const after = await Task.findOne({ codeNumber: '250103' }).lean();
    expect(after.performanceRating).toBe('weak');
    expect(after.syntheticRating).toBeUndefined();
    expect(await HistoricalImportRecord.exists({ sourceKey: 'synthetic-rating:250103' })).toBeNull();
  });

  it('refuses outright if a never-touch task ever reaches the writer', async () => {
    await seed();
    const plan = await loadPlan();
    const testTask = await Task.findOne({ codeNumber: '260912' }).lean();
    plan.items = [{ ...plan.items[1], taskId: String(testTask._id), code: '260912' }];

    await expect(apply(plan)).rejects.toThrow('260912 is on the never-touch list');
    expect((await Task.findOne({ codeNumber: '260912' }).lean()).syntheticRating).toBeUndefined();
  });

  it('leaves an excluded task unrated and byte-identical — it is not in the plan, and the writer would refuse it anyway', async () => {
    await seed();
    const before = await leanByCode();
    const [tasks, importRecords] = await Promise.all([Task.find({}).sort({ codeNumber: 1 }).lean(), HistoricalImportRecord.find({ kind: 'task' }).lean()]);
    // 250101 (the closed, unrated one) is excluded, so the closed group expects none.
    const config = {
      ...CONFIG,
      groups: CONFIG.groups.map((g) => (g.key === 'closedUnrated' ? { ...g, expectedCount: 0 } : g)),
      excludedCodes: { '250101': 'closed as a handover' },
    };
    const plan = buildPlan({ tasks, importRecords, ratingRecords: [], config, now: NOW });
    expect(plan.ok).toBe(true);

    const result = await applyPlan(plan, { importBatch: 'synthetic-rating-test', neverTouchCodes: [...NEVER_TOUCH, '250101'] });

    expect(result).toEqual({ assigned: 2, skipped: [] });
    const after = await leanByCode();
    expect(fingerprint(after['250101'])).toBe(fingerprint(before['250101']));
    expect(after['250101'].performanceRating).toBe('-');
    expect(after['250101'].syntheticRating).toBeUndefined();
    expect(await HistoricalImportRecord.exists({ sourceKey: 'synthetic-rating:250101' })).toBeNull();
  });

  it('rolls a task back completely if its ledger record cannot be written, and a later re-run completes it', async () => {
    await seed();
    const before = await leanByCode();
    const realCreate = HistoricalImportRecord.create.bind(HistoricalImportRecord);
    jest.spyOn(HistoricalImportRecord, 'create').mockImplementationOnce(() => Promise.reject(new Error('simulated failure')));

    await expect(apply(await loadPlan())).rejects.toThrow('simulated failure');
    const afterFailure = await leanByCode();
    Object.keys(before).forEach((code) => expect(fingerprint(afterFailure[code])).toBe(fingerprint(before[code])));
    expect(await HistoricalImportRecord.countDocuments({ action: LEDGER_ACTION })).toBe(0);

    HistoricalImportRecord.create.mockImplementation(realCreate);
    expect(await apply(await loadPlan())).toEqual({ assigned: 3, skipped: [] });
  });
});

describe('synthetic ratings — rollback', () => {
  it('restores every task to exactly the document it was, and retires the ledger records', async () => {
    await seed();
    const original = await leanByCode();
    await apply(await loadPlan());

    const result = await rollbackAll({ now: new Date('2026-10-06T00:00:00.000Z') });

    expect(result).toEqual({ restored: 3, markerOnly: 0, ledgerOnly: 0, notRestoredExactly: [], skipped: [] });
    const after = await leanByCode();
    Object.keys(original).forEach((code) => expect(fingerprint(after[code])).toBe(fingerprint(original[code])));
    expect(await HistoricalImportRecord.countDocuments({ action: LEDGER_ACTION })).toBe(0);
    const retired = await HistoricalImportRecord.findOne({ action: LEDGER_ACTION_ROLLED_BACK, taskCode: '250101' }).lean();
    expect(retired.sourceKey).toBe('synthetic-rating:250101:rolled-back:2026-10-06T00:00:00.000Z');
    expect(retired.flags.rollback).toMatchObject({ action: 'restore', restoredExactly: true });
  });

  it('can be followed by a fresh assignment (the ledger key is freed)', async () => {
    await seed();
    await apply(await loadPlan());
    await rollbackAll({ now: new Date('2026-10-06T00:00:00.000Z') });

    const plan = await loadPlan();
    expect(plan.ok).toBe(true);
    expect(await apply(plan)).toEqual({ assigned: 3, skipped: [] });
  });

  it('never overwrites a rating that changed after assignment — it only removes the synthetic marker', async () => {
    const { admin } = await seed();
    await apply(await loadPlan());
    // A real close happens after the synthetic rating was assigned: the rating is now a real one.
    const pending = await Task.findOne({ codeNumber: '250102' });
    await taskService.closeTask(admin, pending.id);
    const realRating = (await Task.findOne({ codeNumber: '250102' }).lean()).performanceRating;
    expect(realRating).toBe('weak'); // 25% — real, and here equal to the assigned one, so make it differ:
    await Task.updateOne({ codeNumber: '250102' }, { $set: { performanceRating: 'fair' } }, { timestamps: false });

    const result = await rollbackAll({ now: new Date('2026-10-06T00:00:00.000Z') });

    expect(result).toMatchObject({ restored: 2, markerOnly: 1 });
    const after = await Task.findOne({ codeNumber: '250102' }).lean();
    expect(after.performanceRating).toBe('fair'); // kept
    expect(after.status).toBe('closed'); // kept
    expect(after.syntheticRating).toBeUndefined(); // marker removed
  });

  it('planRollback describes each case without writing anything', () => {
    const record = { previous: { performanceRating: '-' }, next: { performanceRating: 'good', assumedPercent: 80 } };
    expect(planRollback(record, null).action).toBe('ledger-only');
    expect(planRollback(record, { performanceRating: '-' }).action).toBe('ledger-only');
    expect(planRollback(record, { performanceRating: 'good', syntheticRating: { isSynthetic: true, assumedPercent: 80 } }).action).toBe('restore');
    expect(planRollback(record, { performanceRating: 'weak', syntheticRating: { isSynthetic: true, assumedPercent: 80 } }).action).toBe('remove-marker-only');
  });
});
