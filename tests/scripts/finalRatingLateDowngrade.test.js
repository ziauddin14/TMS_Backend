const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const TaskUpdate = require('../../src/models/TaskUpdate');
const Notification = require('../../src/models/Notification');
const HistoricalImportRecord = require('../../src/models/HistoricalImportRecord');
const { serializeTask } = require('../../src/serializers/task.serializer');
const { isFinalRating } = require('../../src/utils/syntheticRating');
const { buildPlan, LEDGER_ACTION, LEDGER_ACTION_ROLLED_BACK, HISTORY_AUTHOR } = require('../../scripts/final-rating-late-downgrade/plan');
const { applyPlan, rollbackAll, planRollback } = require('../../scripts/final-rating-late-downgrade/commit');
const { renderPlanReport, renderRollbackReport } = require('../../scripts/final-rating-late-downgrade/report');
const syntheticCommit = require('../../scripts/synthetic-ratings/commit');
const { fingerprint } = syntheticCommit;
const { classify } = require('../../scripts/finalized-estimates/classify');

// scripts/fix-final-rating-late-downgrade.js — corrects the stored band of FINAL ratings on tasks
// completed late (the owner's late rule), and nothing else.
beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const LATE = { type: 'late', days: 117 };

async function seed() {
  const admin = await User.create({ name: 'A', email: `a${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'admin' });
  const script = (p, r) => ({ at: day('2026-10-05'), by: 'system:script', fromPercent: null, toPercent: p, fromRating: '-', toRating: r, note: 'initial synthetic rating' });
  const edit = (from, to, toRating) => ({ at: day('2026-10-10'), by: admin._id, fromPercent: from, toPercent: to, fromRating: 'good', toRating, note: null });
  const sr = (percent, history, extra = {}) => ({ isSynthetic: true, assumedPercent: percent, assignedAt: day('2026-10-05'), assignedBy: 'system:script', reason: 'r', history, ...extra });
  const base = (code, extra) => ({
    codeNumber: code,
    title: `کام ${code}`,
    assignees: [admin._id],
    responsibility: 'R',
    deadline: day('2025-03-31'),
    createdBy: admin._id,
    createdAt: day('2025-01-10'),
    updatedAt: day('2025-07-26'),
    lastUpdateAt: day('2025-07-26'),
    status: 'closed',
    closedAt: day('2025-07-26'),
    closedBy: admin._id,
    completionPercent: 0,
    timeStatus: LATE,
    ...extra,
  });
  const docs = await Task.create(
    [
      // Final from BEFORE the finalize-estimate change (admin entry only): 90% late, stored excellent.
      base('250301', { performanceRating: 'excellent', syntheticRating: sr(90, [script(80, 'good'), edit(80, 90, 'excellent')]) }),
      // Final made through the app (finalizedAt): 80% late, stored good.
      base('250302', { performanceRating: 'good', syntheticRating: sr(80, [script(80, 'good'), edit(80, 80, 'good')], { finalizedAt: day('2026-10-12'), finalizedBy: admin._id }) }),
      // Final 60% late: weak either way — already correct.
      base('250303', { performanceRating: 'weak', syntheticRating: sr(60, [script(80, 'good'), edit(80, 60, 'weak')]) }),
      // Final 90% on time: excellent either way — already correct.
      base('250304', { timeStatus: { type: 'early', days: 2 }, performanceRating: 'excellent', syntheticRating: sr(90, [script(80, 'good'), edit(80, 90, 'excellent')]) }),
      // Final 90% on an OPEN overdue task: no change while it is open.
      base('250305', { status: 'pending', closedAt: null, closedBy: null, timeStatus: { type: 'overdue', days: 200 }, performanceRating: 'excellent', syntheticRating: sr(90, [script(40, 'weak'), edit(40, 90, 'excellent')]) }),
      // Still an estimate, late: never touched (no downgrade for an estimate).
      base('250306', { performanceRating: 'good', syntheticRating: sr(80, [script(80, 'good')]) }),
      // A real rating, late: never touched.
      base('250307', { completionPercent: 50, performanceRating: 'weak' }),
    ],
    { timestamps: false, ordered: true }
  );
  await HistoricalImportRecord.create(
    docs
      .filter((d) => d.syntheticRating)
      .map((d) => ({ importBatch: 'synthetic-rating-v1', sourceKey: `synthetic-rating:${d.codeNumber}`, kind: 'syntheticRating', action: 'synthetic-rating', targetId: d._id, taskCode: d.codeNumber, personKey: 'alpha', next: { group: 'g', performanceRating: 'good', assumedPercent: 80 } }))
  );
  return { admin };
}

async function loadPlan() {
  const [tasks, ledgerRecords, assignRecords] = await Promise.all([
    Task.find({ syntheticRating: { $exists: true } }).sort({ codeNumber: 1 }).lean(),
    HistoricalImportRecord.find({ action: LEDGER_ACTION }).lean(),
    HistoricalImportRecord.find({ action: 'synthetic-rating' }).lean(),
  ]);
  return buildPlan({ tasks, ledgerRecords, assignRecords });
}
const NOW = new Date('2026-10-23T08:00:00.000Z');
const apply = (plan) => applyPlan(plan, { importBatch: 'final-rating-late-downgrade-test', now: NOW });
const byCode = async (code) => Task.findOne({ codeNumber: code }).lean();
const allByCode = async () => Object.fromEntries((await Task.find({}).lean()).map((t) => [t.codeNumber, t]));
const withoutHistory = (doc) => {
  const rest = { ...doc.syntheticRating };
  delete rest.history;
  return rest;
};

describe('the plan (dry run)', () => {
  it('plans exactly the final ratings completed late whose band is still the plain one', async () => {
    await seed();
    const plan = await loadPlan();

    expect(plan.ok).toBe(true);
    expect(plan.items.map((i) => [i.code, i.from, i.to, i.assumedPercent, i.daysLate])).toEqual([
      ['250301', 'excellent', 'good', 90, 117],
      ['250302', 'good', 'fair', 80, 117],
    ]);
    expect(plan.byChange).toEqual({ 'excellent→good': 1, 'good→fair': 1 });
    expect(plan.alreadyCorrect.map((t) => t.code)).toEqual(['250303', '250304']);
    expect(plan.openFinals.map((t) => t.code)).toEqual(['250305']);
    expect(plan.totals).toMatchObject({ finalRatings: 5, toFix: 2, alreadyCorrect: 2, openFinals: 1, anomalies: 0 });
    expect(plan.items[0].personKey).toBe('alpha');

    const md = renderPlanReport(plan, { meta: { mode: 'DRY RUN', generatedAt: 'x', importBatch: 'b' } });
    expect(md).toContain('**to correct: 2**');
    expect(md).toContain('excellent → good: 1');
    expect(md).toMatch(/\| 250301 \| closed \| 90% \|/);
  });

  it('a final rating that fits neither the old nor the new rule is an anomaly: listed, never planned, and the checks fail', async () => {
    await seed();
    await Task.collection.updateOne({ codeNumber: '250301' }, { $set: { performanceRating: 'fair' } }); // 90% late: neither excellent nor good
    await Task.collection.updateOne({ codeNumber: '250305' }, { $set: { performanceRating: 'good' } }); // open, yet not the plain band

    const plan = await loadPlan();

    expect(plan.ok).toBe(false);
    expect(plan.items.map((i) => i.code)).toEqual(['250302']);
    expect(plan.anomalies.join(' ')).toMatch(/250301: band "fair"/);
    expect(plan.anomalies.join(' ')).toMatch(/250305: open/);
  });
});

describe('the commit', () => {
  it('writes only the band and one history entry by system:script — every other field byte-identical — plus one ledger record per task', async () => {
    await seed();
    const before = await allByCode();
    const result = await apply(await loadPlan());

    expect(result).toEqual({ fixed: 2, skipped: [] });
    const after = await allByCode();
    for (const [code, to] of [['250301', 'good'], ['250302', 'fair']]) {
      expect(after[code].performanceRating).toBe(to);
      expect(fingerprint(after[code], ['performanceRating', 'syntheticRating'])).toBe(fingerprint(before[code], ['performanceRating', 'syntheticRating']));
      expect(fingerprint(withoutHistory(after[code]))).toBe(fingerprint(withoutHistory(before[code])));
      expect(after[code].syntheticRating.history).toHaveLength(before[code].syntheticRating.history.length + 1);
      expect(after[code].syntheticRating.history.at(-1)).toMatchObject({ by: HISTORY_AUTHOR, fromRating: before[code].performanceRating, toRating: to });
      // Still final — a string author is never an admin edit — and shown as final.
      expect(isFinalRating(after[code].syntheticRating)).toBe(true);
      expect(serializeTask(after[code], { role: 'admin' }).syntheticRating).toMatchObject({ isFinal: true, isSynthetic: false });
    }
    // Everything else untouched, byte for byte.
    ['250303', '250304', '250305', '250306', '250307'].forEach((code) => expect(fingerprint(after[code])).toBe(fingerprint(before[code])));
    expect(await TaskUpdate.countDocuments({})).toBe(0);
    expect(await Notification.countDocuments({})).toBe(0);

    const ledger = await HistoricalImportRecord.find({ action: LEDGER_ACTION }).sort({ taskCode: 1 }).lean();
    expect(ledger.map((r) => [r.taskCode, r.sourceKey, r.previous.performanceRating, r.next.performanceRating])).toEqual([
      ['250301', 'final-rating-late-downgrade:250301', 'excellent', 'good'],
      ['250302', 'final-rating-late-downgrade:250302', 'good', 'fair'],
    ]);
  });

  it('is idempotent: a re-run plans nothing, and the old plan is skipped by its ledger records', async () => {
    await seed();
    const plan = await loadPlan();
    await apply(plan);

    const again = await loadPlan();
    expect(again.ok).toBe(true);
    expect(again.items).toEqual([]);
    expect(again.alreadyFixed.map((t) => t.code)).toEqual(['250301', '250302']);
    const rerun = await apply(plan);
    expect(rerun.fixed).toBe(0);
    expect(rerun.skipped.map((s) => s.reason)).toEqual(['ledger record already exists', 'ledger record already exists']);
  });

  it('skips a task that changed between planning and writing, instead of overwriting it', async () => {
    await seed();
    const plan = await loadPlan();
    await Task.collection.updateOne({ codeNumber: '250301' }, { $set: { performanceRating: 'fair' } });
    const before = await byCode('250301');

    const result = await apply(plan);

    expect(result.fixed).toBe(1);
    expect(result.skipped).toEqual([{ code: '250301', reason: expect.stringMatching(/changed since planning/) }]);
    expect(fingerprint(await byCode('250301'))).toBe(fingerprint(before));
  });

  it('the other scripts still treat a corrected rating as final: the synthetic-ratings rollback skips it; the review lists nothing left to change', async () => {
    await seed();
    await apply(await loadPlan());
    const fixed = await byCode('250301');
    const assignRecord = await HistoricalImportRecord.findOne({ action: 'synthetic-rating', taskCode: '250301' }).lean();

    expect(syntheticCommit.planRollback(assignRecord, fixed).action).toBe('skip-finalized');
    const tasks = await Task.find({ syntheticRating: { $exists: true } }).lean();
    const review = classify({ tasks, assignRecords: await HistoricalImportRecord.find({ action: 'synthetic-rating' }).lean() });
    expect(review.lists.bandWouldChange).toEqual([]);
    expect(review.lists.becomesFinal.map((t) => t.code)).toEqual(['250301', '250302', '250303', '250304', '250305']);
    expect(review.lists.ambiguous).toEqual([]);
  });
});

describe('the rollback', () => {
  it('restores every untouched task exactly and retires its ledger records; the tasks can be corrected again afterwards', async () => {
    await seed();
    const before = await allByCode();
    await apply(await loadPlan());

    const result = await rollbackAll({ now: new Date('2026-10-24T00:00:00.000Z') });

    expect(result).toMatchObject({ restored: 2, ledgerOnly: 0, notRestoredExactly: [], skipped: [] });
    const after = await allByCode();
    ['250301', '250302'].forEach((code) => expect(fingerprint(after[code])).toBe(fingerprint(before[code])));
    expect(await HistoricalImportRecord.countDocuments({ action: LEDGER_ACTION })).toBe(0);
    expect(await HistoricalImportRecord.countDocuments({ action: LEDGER_ACTION_ROLLED_BACK })).toBe(2);
    expect((await loadPlan()).items.map((i) => i.code)).toEqual(['250301', '250302']);
  });

  it('a task changed since the correction is left exactly as it is, and its ledger record stays active', async () => {
    await seed();
    await apply(await loadPlan());
    await Task.collection.updateOne({ codeNumber: '250302' }, { $set: { performanceRating: 'weak' } });
    const changed = await byCode('250302');

    const records = await HistoricalImportRecord.find({ action: LEDGER_ACTION }).sort({ taskCode: 1 }).lean();
    const rows = await Promise.all(records.map(async (r) => ({ code: r.taskCode, ...planRollback(r, await Task.findById(r.targetId).lean()) })));
    expect(rows.map((r) => [r.code, r.action])).toEqual([
      ['250301', 'restore'],
      ['250302', 'skip-changed'],
    ]);
    expect(renderRollbackReport(rows, { meta: { mode: 'DRY RUN', generatedAt: 'x' } })).toContain('skip-changed: 1');

    const result = await rollbackAll({ now: new Date('2026-10-24T00:00:00.000Z') });

    expect(result.restored).toBe(1);
    expect(result.skipped.map((s) => s.code)).toEqual(['250302']);
    expect(fingerprint(await byCode('250302'))).toBe(fingerprint(changed));
    expect(await HistoricalImportRecord.countDocuments({ action: LEDGER_ACTION, taskCode: '250302' })).toBe(1);
  });
});
