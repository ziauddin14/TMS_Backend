const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const TaskUpdate = require('../../src/models/TaskUpdate');
const Notification = require('../../src/models/Notification');
const HistoricalImportRecord = require('../../src/models/HistoricalImportRecord');
const { serializeTask } = require('../../src/serializers/task.serializer');
const { isFinalRating } = require('../../src/utils/syntheticRating');
const { loadPlan } = require('../../scripts/reopen-stuck-complete/load');
const { LEDGER_ACTION, LEDGER_ACTION_ROLLED_BACK, HISTORY_AUTHOR, lastCompletion } = require('../../scripts/reopen-stuck-complete/plan');
const { applyPlan, rollbackAll, planRollback, CHANGED_FIELDS } = require('../../scripts/reopen-stuck-complete/commit');
const { renderPlanReport, renderRollbackReport } = require('../../scripts/reopen-stuck-complete/report');
const { fingerprint } = require('../../scripts/synthetic-ratings/commit');
const lateDowngrade = require('../../scripts/final-rating-late-downgrade/plan');

// scripts/reopen-stuck-complete.js — reopens the tasks the code before the reopen fix left
// "complete" below 100% (category A), and nothing else; B and C are listed only.
beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

const at = (iso) => new Date(iso);
const DEADLINE_PAST = at('2026-10-21T12:00:00.000Z'); // 21-10 in Pakistan
const DEADLINE_AHEAD = at('2026-10-30T12:00:00.000Z');
const NOW = at('2026-10-24T08:00:00.000Z'); // 24-10 in Pakistan: 3 days past DEADLINE_PAST
const REOPEN_AT = '2026-10-22T11:50:00.000Z'; // the admin's update that left them stuck
const ASSIGNED_AT = at('2026-10-05T06:00:00.000Z');

async function seed({ withAnomalies = false } = {}) {
  const admin = await User.create({ name: 'A', email: `a${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'admin' });
  const user = await User.create({ name: 'Z', email: `z${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'user' });
  const script = (percent, rating) => ({ at: ASSIGNED_AT, by: 'system:script', fromPercent: null, toPercent: percent, fromRating: '-', toRating: rating, note: 'initial synthetic rating' });
  const base = (code, extra) => ({
    codeNumber: code,
    title: `کام ${code}`,
    assignees: [user._id],
    responsibility: 'R',
    deadline: DEADLINE_PAST,
    createdBy: admin._id,
    createdAt: at('2026-10-01T05:00:00.000Z'),
    updatedAt: at(REOPEN_AT),
    lastUpdateAt: at(REOPEN_AT),
    status: 'complete',
    ...extra,
  });
  const stuck = { completionPercent: 0, timeStatus: { type: 'late', days: 1 }, performanceRating: 'weak' };
  const docs = await Task.create(
    [
      // The 261006 case: completed on the due date, then an admin's 0% the next day.
      base('261006', stuck),
      // Stuck at 40%, deadline still ahead.
      base('261007', { ...stuck, deadline: DEADLINE_AHEAD, completionPercent: 40, timeStatus: { type: 'early', days: 8 } }),
      // Stuck, with a FINAL rating stored one level down (completed late): back to the plain band.
      base('261008', {
        ...stuck,
        performanceRating: 'good',
        syntheticRating: {
          isSynthetic: true,
          assumedPercent: 90,
          assignedAt: ASSIGNED_AT,
          assignedBy: 'system:script',
          reason: 'r',
          finalizedAt: ASSIGNED_AT,
          finalizedBy: admin._id,
          history: [script(80, 'good'), { at: ASSIGNED_AT, by: admin._id, fromPercent: 80, toPercent: 90, fromRating: 'good', toRating: 'excellent', note: null }],
        },
      }),
      // Stuck, with a rating that is still an ESTIMATE: it stays.
      base('261009', { ...stuck, completionPercent: 50, performanceRating: 'good', syntheticRating: { isSynthetic: true, assumedPercent: 80, assignedAt: ASSIGNED_AT, assignedBy: 'system:script', reason: 'r', history: [script(80, 'good')] } }),
      // B: complete at 100% on the due date, shown late because of a comment the next day.
      base('261011', { completionPercent: 100, timeStatus: { type: 'late', days: 1 }, performanceRating: 'good' }),
      // C: reached 100%, dropped to 30%, then closed.
      base('261012', { status: 'closed', completionPercent: 30, closedAt: at('2026-10-23T06:00:00.000Z'), closedBy: admin._id, timeStatus: { type: 'late', days: 1 }, performanceRating: 'weak' }),
      // Neither: an ordinary on-time completion, and a task closed without ever reaching 100%.
      base('261013', { completionPercent: 100, lastUpdateAt: at('2026-10-21T10:00:00.000Z'), timeStatus: { type: 'early', days: 0 }, performanceRating: 'excellent' }),
      base('261014', { status: 'closed', completionPercent: 0, closedAt: at('2026-10-23T06:00:00.000Z'), closedBy: admin._id, timeStatus: { type: 'late', days: 1 }, performanceRating: 'weak' }),
      ...(withAnomalies ? [base('250501', stuck), base('261010', { ...stuck, lastUpdateAt: null })] : []),
    ],
    { timestamps: false, ordered: true }
  );
  const byCode = Object.fromEntries(docs.map((d) => [d.codeNumber, d]));
  const updates = {
    261006: [[0, '2026-10-21T09:13:00.000Z'], [100, '2026-10-21T15:26:00.000Z'], [100, '2026-10-21T15:28:00.000Z'], [0, REOPEN_AT]],
    261007: [[100, '2026-10-20T10:00:00.000Z'], [40, REOPEN_AT]],
    261008: [[100, '2026-10-22T10:00:00.000Z'], [0, REOPEN_AT]],
    261009: [[100, '2026-10-20T10:00:00.000Z'], [50, REOPEN_AT]],
    261011: [[100, '2026-10-21T10:00:00.000Z'], [100, REOPEN_AT]],
    261012: [[100, '2026-10-20T10:00:00.000Z'], [30, REOPEN_AT]],
    261013: [[100, '2026-10-21T10:00:00.000Z']],
    261014: [[0, '2026-10-20T10:00:00.000Z']],
    ...(withAnomalies ? { 250501: [[100, '2026-10-20T10:00:00.000Z'], [0, REOPEN_AT]] } : {}),
  };
  await TaskUpdate.create(
    Object.entries(updates).flatMap(([code, rows]) =>
      rows.map(([completionPercent, createdAt]) => ({ taskId: byCode[code]._id, updatedBy: user._id, description: 'اپڈیٹ', completionPercent, createdAt: at(createdAt) }))
    )
  );
  if (withAnomalies) {
    await HistoricalImportRecord.create({ importBatch: 'historical-followup-v1', sourceKey: 'task:250501', kind: 'task', targetId: byCode['250501']._id, taskCode: '250501', personKey: 'alpha' });
  }
  return { admin, user };
}

const plan = () => loadPlan(NOW);
const apply = (p) => applyPlan(p, { importBatch: 'reopen-stuck-complete-test', now: NOW });
const byCode = async (code) => Task.findOne({ codeNumber: code }).lean();
const allByCode = async () => Object.fromEntries((await Task.find({}).lean()).map((t) => [t.codeNumber, t]));
const withoutHistory = (doc) => {
  const rest = { ...doc.syntheticRating };
  delete rest.history;
  return rest;
};

describe('the plan (dry run)', () => {
  it('A: reopens exactly the tasks stuck "complete" below 100% — ongoing, or pending past the deadline — and lists B and C only', async () => {
    await seed();
    const p = await plan();

    expect(p.ok).toBe(true);
    expect(p.items.map((i) => [i.code, i.completionPercent, i.to.status, i.to.timeStatus, i.from.performanceRating, i.to.performanceRating, i.ratingKind])).toEqual([
      ['261006', 0, 'pending', { type: 'overdue', days: 3 }, 'weak', '-', 'real'],
      ['261007', 40, 'ongoing', { type: 'remaining', days: 6 }, 'weak', '-', 'real'],
      ['261008', 0, 'pending', { type: 'overdue', days: 3 }, 'good', 'excellent', 'final'],
      ['261009', 50, 'pending', { type: 'overdue', days: 3 }, 'good', 'good', 'estimate'],
    ]);
    expect(p.items[0].reached100At).toBe('2026-10-21T15:26:00.000Z');
    expect(p.byNewStatus).toEqual({ pending: 3, ongoing: 1 });
    expect(p.lateOnlyByLaterUpdate).toEqual([
      { code: '261011', shownLateDays: 1, completedOn: '2026-10-21T10:00:00.000Z', daysBeforeDeadline: 0, lastUpdateAt: REOPEN_AT, imported: false },
    ]);
    expect(p.closedAfterDrop.map((r) => [r.code, r.completionPercent, r.reached100At, r.droppedAt])).toEqual([['261012', 30, '2026-10-20T10:00:00.000Z', REOPEN_AT]]);
    expect(p.totals).toEqual({ toRepair: 4, anomalies: 0, alreadyRepaired: 0, lateOnlyByLaterUpdate: 1, closedAfterDrop: 1 });

    const md = renderPlanReport(p, { meta: { mode: 'DRY RUN', generatedAt: 'x', importBatch: 'b' } });
    expect(md).toContain('**A. to reopen: 4**');
    expect(md).toContain('| 261006 | 0% | 2026-10-21 | 2026-10-22 | 2026-10-21 | complete → pending | late 1 → overdue 3 | weak (کمزور) → - | real |');
    expect(md).toMatch(/\| 261011 \| 1 \| 2026-10-21 \| 0 \|/);
    expect(md).not.toContain('کام 261006'); // codes only, never titles
  });

  it('a stuck task it cannot repair with confidence is an anomaly: listed, never planned, and the checks fail', async () => {
    await seed({ withAnomalies: true });
    const p = await plan();

    expect(p.ok).toBe(false);
    expect(p.items.map((i) => i.code)).toEqual(['261006', '261007', '261008', '261009']);
    expect(p.anomalies.join(' ')).toMatch(/250501: complete at 0% — an imported task/);
    expect(p.anomalies.join(' ')).toMatch(/261010: complete at 0% — no updates at all/);
  });

  it('lastCompletion: the first update of the last run at 100%', () => {
    const u = (completionPercent, createdAt) => ({ completionPercent, createdAt });
    expect(lastCompletion([u(100, 1), u(40, 2), u(100, 3), u(100, 4)])).toEqual(u(100, 3));
    expect(lastCompletion([u(40, 1)])).toBeNull();
  });
});

describe('the commit', () => {
  it('writes only status, timeStatus, the rating and completedAt (plus one entry for a final) — every other field byte-identical — and one ledger record per task', async () => {
    await seed();
    const before = await allByCode();
    const updatesBefore = await TaskUpdate.countDocuments({});

    const result = await apply(await plan());

    expect(result).toEqual({ repaired: 4, skipped: [] });
    const after = await allByCode();
    expect(after['261006']).toMatchObject({ status: 'pending', timeStatus: { type: 'overdue', days: 3 }, performanceRating: '-', completionPercent: 0 });
    expect(after['261007']).toMatchObject({ status: 'ongoing', timeStatus: { type: 'remaining', days: 6 }, performanceRating: '-', completionPercent: 40 });
    expect(after['261008']).toMatchObject({ status: 'pending', performanceRating: 'excellent' });
    expect(after['261009']).toMatchObject({ status: 'pending', performanceRating: 'good' });
    ['261006', '261007', '261008', '261009'].forEach((code) => {
      expect(fingerprint(after[code], CHANGED_FIELDS)).toBe(fingerprint(before[code], CHANGED_FIELDS));
      expect(after[code]).not.toHaveProperty('completedAt');
      expect(after[code].updatedAt.getTime()).toBe(before[code].updatedAt.getTime());
    });
    // The final rating: same percent, plain band, one entry by a string author — still final.
    expect(fingerprint(withoutHistory(after['261008']))).toBe(fingerprint(withoutHistory(before['261008'])));
    expect(after['261008'].syntheticRating.history).toHaveLength(before['261008'].syntheticRating.history.length + 1);
    expect(after['261008'].syntheticRating.history.at(-1)).toMatchObject({ by: HISTORY_AUTHOR, fromPercent: 90, toPercent: 90, fromRating: 'good', toRating: 'excellent' });
    expect(isFinalRating(after['261008'].syntheticRating)).toBe(true);
    // The estimate: untouched.
    expect(fingerprint(after['261009'].syntheticRating)).toBe(fingerprint(before['261009'].syntheticRating));
    // What the app shows: an open task with no rating.
    expect(serializeTask(after['261006'], { role: 'admin' })).toMatchObject({ status: 'pending', performanceRating: '-' });
    // Everything else untouched, byte for byte; no update, no notification.
    ['261011', '261012', '261013', '261014'].forEach((code) => expect(fingerprint(after[code])).toBe(fingerprint(before[code])));
    expect(await TaskUpdate.countDocuments({})).toBe(updatesBefore);
    expect(await Notification.countDocuments({})).toBe(0);

    const ledger = await HistoricalImportRecord.find({ action: LEDGER_ACTION }).sort({ taskCode: 1 }).lean();
    expect(ledger.map((r) => [r.taskCode, r.kind, r.sourceKey, r.previous.status, r.previous.performanceRating, r.next.status, r.next.performanceRating])).toEqual([
      ['261006', 'taskRepair', 'reopen-stuck-complete:261006', 'complete', 'weak', 'pending', '-'],
      ['261007', 'taskRepair', 'reopen-stuck-complete:261007', 'complete', 'weak', 'ongoing', '-'],
      ['261008', 'taskRepair', 'reopen-stuck-complete:261008', 'complete', 'good', 'pending', 'excellent'],
      ['261009', 'taskRepair', 'reopen-stuck-complete:261009', 'complete', 'good', 'pending', 'good'],
    ]);
  });

  it('is idempotent: a re-run plans nothing, and the old plan is skipped by its ledger records', async () => {
    await seed();
    const p = await plan();
    await apply(p);

    const again = await plan();
    expect(again.ok).toBe(true);
    expect(again.items).toEqual([]);
    expect(again.totals.alreadyRepaired).toBe(4);
    const rerun = await apply(p);
    expect(rerun.repaired).toBe(0);
    expect(rerun.skipped.map((s) => s.reason)).toEqual(Array(4).fill('ledger record already exists'));
  });

  it('skips a task that changed between planning and writing, instead of overwriting it', async () => {
    await seed();
    const p = await plan();
    await Task.collection.updateOne({ codeNumber: '261006' }, { $set: { completionPercent: 20, lastUpdateAt: new Date() } });
    const before = await byCode('261006');

    const result = await apply(p);

    expect(result.repaired).toBe(3);
    expect(result.skipped).toEqual([{ code: '261006', reason: expect.stringMatching(/changed since planning/) }]);
    expect(fingerprint(await byCode('261006'))).toBe(fingerprint(before));
  });

  it('the late-downgrade plan reads a reopened final as an open final with its plain band — no anomaly', async () => {
    await seed();
    await apply(await plan());

    const tasks = await Task.find({ syntheticRating: { $exists: true } }).lean();
    const other = lateDowngrade.buildPlan({ tasks });
    expect(other.openFinals.map((t) => t.code)).toEqual(['261008']);
    expect(other.anomalies).toEqual([]);
  });
});

describe('the rollback', () => {
  it('restores every untouched task exactly and retires its ledger records; they can be repaired again afterwards', async () => {
    await seed();
    const before = await allByCode();
    await apply(await plan());

    const result = await rollbackAll({ now: at('2026-10-25T00:00:00.000Z') });

    expect(result).toMatchObject({ restored: 4, ledgerOnly: 0, notRestoredExactly: [], skipped: [] });
    const after = await allByCode();
    ['261006', '261007', '261008', '261009'].forEach((code) => expect(fingerprint(after[code])).toBe(fingerprint(before[code])));
    expect(await HistoricalImportRecord.countDocuments({ action: LEDGER_ACTION })).toBe(0);
    expect(await HistoricalImportRecord.countDocuments({ action: LEDGER_ACTION_ROLLED_BACK })).toBe(4);
    expect((await plan()).items.map((i) => i.code)).toEqual(['261006', '261007', '261008', '261009']);
  });

  it("the reminder engine's daily changes do not block it; a task updated since is left exactly as it is", async () => {
    await seed();
    await apply(await plan());
    // The engine's next run: one more day overdue, ongoing -> pending, updatedAt moved.
    await Task.collection.updateOne({ codeNumber: '261007' }, { $set: { status: 'pending', timeStatus: { type: 'overdue', days: 1 }, updatedAt: new Date() } });
    // Someone posted an update on 261006 since.
    await Task.collection.updateOne({ codeNumber: '261006' }, { $set: { completionPercent: 20, lastUpdateAt: new Date() } });
    const changed = await byCode('261006');

    const records = await HistoricalImportRecord.find({ action: LEDGER_ACTION }).sort({ taskCode: 1 }).lean();
    const rows = await Promise.all(records.map(async (r) => ({ code: r.taskCode, ...planRollback(r, await Task.findById(r.targetId).lean()) })));
    expect(rows.map((r) => [r.code, r.action])).toEqual([
      ['261006', 'skip-changed'],
      ['261007', 'restore'],
      ['261008', 'restore'],
      ['261009', 'restore'],
    ]);
    expect(renderRollbackReport(rows, { meta: { mode: 'DRY RUN', generatedAt: 'x' } })).toContain('skip-changed: 1');

    const result = await rollbackAll({ now: at('2026-10-25T00:00:00.000Z') });

    expect(result.restored).toBe(3);
    expect(result.notRestoredExactly).toEqual(['261007']); // its updatedAt moved meanwhile
    expect(await byCode('261007')).toMatchObject({ status: 'complete', completionPercent: 40, timeStatus: { type: 'early', days: 8 }, performanceRating: 'weak' });
    expect(result.skipped.map((s) => s.code)).toEqual(['261006']);
    expect(fingerprint(await byCode('261006'))).toBe(fingerprint(changed));
    expect(await HistoricalImportRecord.countDocuments({ action: LEDGER_ACTION, taskCode: '261006' })).toBe(1);
  });
});
