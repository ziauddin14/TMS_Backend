const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const HistoricalImportRecord = require('../../src/models/HistoricalImportRecord');
const reportService = require('../../src/services/report.service');

// An admin's edit makes a synthetic ("تخمینی") rating FINAL (src/utils/syntheticRating.js): the
// edit itself (audit trail, ledger, race safety), the 409s afterwards, the real-rating path that
// never replaces it, and every consumer that now counts it as a real rating.
beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

const tokenFor = (user) => jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
const auth = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const ASSIGNED_AT = day('2026-10-05');

function fingerprint(doc) {
  return crypto.createHash('sha256').update(mongoose.mongo.BSON.EJSON.stringify(doc, { relaxed: false })).digest('hex');
}

async function seed() {
  const admin = await User.create({ name: 'Admin', email: `a${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'Admin', role: 'admin' });
  const assignee = await User.create({ name: 'Zimmedar', email: `z${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'user' });
  const base = (code, extra) => ({
    codeNumber: code,
    title: `کام ${code}`,
    assignees: [assignee._id],
    responsibility: 'R',
    deadline: day('2025-03-31'),
    createdBy: admin._id,
    createdAt: day('2025-01-10'),
    updatedAt: day('2025-04-20'),
    lastUpdateAt: day('2025-04-20'),
    ...extra,
  });
  const scriptEntry = (assumedPercent, rating) => ({ at: ASSIGNED_AT, by: 'system:script', fromPercent: null, toPercent: assumedPercent, fromRating: '-', toRating: rating, note: 'initial synthetic rating' });
  const syn = (assumedPercent, rating, extra) => ({
    isSynthetic: true,
    assumedPercent,
    assignedAt: ASSIGNED_AT,
    assignedBy: 'system:script',
    reason: 'internal reason',
    history: [scriptEntry(assumedPercent, rating)],
    ...extra,
  });
  const [closedEstimate, pendingEstimate, legacyFinal, realRated] = await Task.create(
    [
      // Closed late at a real 0% — the estimate (80%, "good") an admin will change.
      base('250126', { status: 'closed', closedAt: day('2025-04-20'), closedBy: admin._id, timeStatus: { type: 'late', days: 20 }, performanceRating: 'good', syntheticRating: syn(80, 'good') }),
      base('250102', { status: 'pending', completionPercent: 25, timeStatus: { type: 'overdue', days: 500 }, performanceRating: 'weak', syntheticRating: syn(40, 'weak') }),
      // Edited by an admin BEFORE this change: an admin entry in its history, no finalizedAt.
      base('250103', {
        status: 'closed',
        closedAt: day('2025-04-20'),
        closedBy: admin._id,
        timeStatus: { type: 'late', days: 20 },
        performanceRating: 'excellent',
        syntheticRating: syn(95, 'excellent', {
          history: [scriptEntry(80, 'good'), { at: day('2026-10-10'), by: admin._id, fromPercent: 80, toPercent: 95, fromRating: 'good', toRating: 'excellent', note: null }],
        }),
      }),
      base('250104', { status: 'closed', closedAt: day('2025-03-20'), closedBy: admin._id, completionPercent: 50, timeStatus: { type: 'early', days: 11 }, performanceRating: 'weak' }),
    ],
    { timestamps: false, ordered: true }
  );
  // The assignment ledger records, as the script writes them.
  await HistoricalImportRecord.create(
    [closedEstimate, pendingEstimate, legacyFinal].map((t) => ({
      importBatch: 'synthetic-rating-v1',
      sourceKey: `synthetic-rating:${t.codeNumber}`,
      kind: 'syntheticRating',
      action: 'synthetic-rating',
      targetId: t._id,
      taskCode: t.codeNumber,
      personKey: 'alpha',
      next: { group: 'g', performanceRating: t.performanceRating, assumedPercent: t.syntheticRating.assumedPercent },
    }))
  );
  return { admin, assignee, closedEstimate, pendingEstimate, legacyFinal, realRated };
}
const lean = (task) => Task.findById(task._id).lean();
const url = (task) => `/api/v1/tasks/${task.id}/synthetic-rating`;
const adminEntries = (doc) => doc.syntheticRating.history.filter((e) => e.by instanceof mongoose.Types.ObjectId && typeof e.toPercent === 'number');

describe('PATCH — an admin edit makes the rating FINAL', () => {
  it('stores finalizedAt/finalizedBy and the history entry; the response says final, no longer an estimate', async () => {
    const { admin, closedEstimate } = await seed();
    const startedAt = Date.now();

    const res = await request(app).patch(url(closedEstimate)).set(auth(admin)).send({ assumedPercent: 95, note: 'جائزہ مکمل' });

    expect(res.status).toBe(200);
    expect(res.body.data.performanceRating).toBe('good'); // 95% = excellent, one level down: completed late
    expect(res.body.data.syntheticRating).toMatchObject({ isSynthetic: false, isFinal: true, assumedPercent: 95 });
    const stored = await lean(closedEstimate);
    expect(stored.syntheticRating).toMatchObject({ isSynthetic: true, assumedPercent: 95 }); // still synthetic in the store
    expect(String(stored.syntheticRating.finalizedBy)).toBe(admin.id);
    expect(stored.syntheticRating.finalizedAt.getTime()).toBeGreaterThanOrEqual(startedAt);
    const last = stored.syntheticRating.history.at(-1);
    expect(last).toMatchObject({ fromPercent: 80, toPercent: 95, fromRating: 'good', toRating: 'good', note: 'جائزہ مکمل' });
    expect(String(last.by)).toBe(admin.id);
    expect(last.at.getTime()).toBe(stored.syntheticRating.finalizedAt.getTime());
    // Real fields untouched.
    expect(stored).toMatchObject({ status: 'closed', completionPercent: 0 });
  });

  it('writes the edit to the ledger too: who, when, the old and the new value and the reason', async () => {
    const { admin, closedEstimate } = await seed();
    await request(app).patch(url(closedEstimate)).set(auth(admin)).send({ assumedPercent: 92, note: 'وجہ' });

    const record = await HistoricalImportRecord.findOne({ action: 'synthetic-rating-finalized' }).lean();
    expect(record).toMatchObject({
      kind: 'syntheticRating',
      taskCode: '250126',
      sourceKey: 'synthetic-rating-finalized:250126',
      personKey: 'alpha', // carried over from the task's assignment record
      previous: { performanceRating: 'good', assumedPercent: 80, isSynthetic: true },
      next: { performanceRating: 'good', assumedPercent: 92, note: 'وجہ' }, // 92% late: one level down
    });
    expect(String(record.targetId)).toBe(closedEstimate.id);
    expect(String(record.next.finalizedBy)).toBe(admin.id);
    // The assignment record is left exactly as it was.
    expect(await HistoricalImportRecord.countDocuments({ action: 'synthetic-rating' })).toBe(3);
  });

  it('the reason stays optional', async () => {
    const { admin, closedEstimate } = await seed();
    const res = await request(app).patch(url(closedEstimate)).set(auth(admin)).send({ assumedPercent: 85 });
    expect(res.status).toBe(200);
    expect((await lean(closedEstimate)).syntheticRating.history.at(-1).note).toBeNull();
  });

  it('a final rating cannot be edited again — 409 SYNTHETIC_RATING_FINAL, and nothing changes', async () => {
    const { admin, closedEstimate } = await seed();
    await request(app).patch(url(closedEstimate)).set(auth(admin)).send({ assumedPercent: 95 });
    const before = await lean(closedEstimate);

    const res = await request(app).patch(url(closedEstimate)).set(auth(admin)).send({ assumedPercent: 60 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'SYNTHETIC_RATING_FINAL' });
    expect(fingerprint(await lean(closedEstimate))).toBe(fingerprint(before));
  });

  it('a final rating cannot be removed — 409 SYNTHETIC_RATING_FINAL, and nothing changes', async () => {
    const { admin, closedEstimate } = await seed();
    await request(app).patch(url(closedEstimate)).set(auth(admin)).send({ assumedPercent: 95 });
    const before = await lean(closedEstimate);

    const res = await request(app).delete(url(closedEstimate)).set(auth(admin));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SYNTHETIC_RATING_FINAL');
    expect(fingerprint(await lean(closedEstimate))).toBe(fingerprint(before));
  });

  it('an estimate edited BEFORE this change (admin entry in its history) is final too: PATCH and DELETE are 409', async () => {
    const { admin, legacyFinal } = await seed();
    const before = await lean(legacyFinal);

    const patched = await request(app).patch(url(legacyFinal)).set(auth(admin)).send({ assumedPercent: 50 });
    const deleted = await request(app).delete(url(legacyFinal)).set(auth(admin));

    expect([patched.status, deleted.status]).toEqual([409, 409]);
    expect([patched.body.code, deleted.body.code]).toEqual(['SYNTHETIC_RATING_FINAL', 'SYNTHETIC_RATING_FINAL']);
    expect(fingerprint(await lean(legacyFinal))).toBe(fingerprint(before)); // recognised at read time — nothing written
  });

  it('two simultaneous edits: exactly one wins, the other gets 409 — one history entry, one ledger record', async () => {
    const { admin, closedEstimate } = await seed();

    const results = await Promise.all([
      request(app).patch(url(closedEstimate)).set(auth(admin)).send({ assumedPercent: 91 }),
      request(app).patch(url(closedEstimate)).set(auth(admin)).send({ assumedPercent: 61 }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409).body.code).toBe('SYNTHETIC_RATING_FINAL');
    const stored = await lean(closedEstimate);
    expect(adminEntries(stored)).toHaveLength(1);
    expect(stored.syntheticRating.assumedPercent).toBe(results.find((r) => r.status === 200).body.data.syntheticRating.assumedPercent);
    expect(await HistoricalImportRecord.countDocuments({ action: 'synthetic-rating-finalized' })).toBe(1);
  });

  it('an edit and a removal at the same moment: exactly one wins', async () => {
    const { admin, closedEstimate } = await seed();
    const results = await Promise.all([
      request(app).patch(url(closedEstimate)).set(auth(admin)).send({ assumedPercent: 91 }),
      request(app).delete(url(closedEstimate)).set(auth(admin)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('still admin-only, also on a final rating', async () => {
    const { admin, assignee, closedEstimate } = await seed();
    await request(app).patch(url(closedEstimate)).set(auth(admin)).send({ assumedPercent: 95 });
    expect((await request(app).patch(url(closedEstimate)).set(auth(assignee)).send({ assumedPercent: 10 })).status).toBe(403);
    expect((await request(app).delete(url(closedEstimate)).set(auth(assignee))).status).toBe(403);
  });

  it('an estimate that was never edited can still be removed, exactly as before', async () => {
    const { admin, pendingEstimate } = await seed();
    const res = await request(app).delete(url(pendingEstimate)).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ performanceRating: '-', syntheticRating: { isSynthetic: false, isFinal: false } });
  });
});

describe('a final rating is never replaced by a real one', () => {
  it('a later update on the open task keeps it', async () => {
    const { admin, assignee, pendingEstimate } = await seed();
    await request(app).patch(url(pendingEstimate)).set(auth(admin)).send({ assumedPercent: 85 });

    const res = await request(app).post(`/api/v1/tasks/${pendingEstimate.id}/updates`).set(auth(assignee)).send({ description: 'جاری', completionPercent: 30 });

    expect(res.status).toBe(201);
    expect(res.body.data.task).toMatchObject({ performanceRating: 'good', completionPercent: 30, syntheticRating: { isFinal: true } });
  });

  it('closing the task: status, timeStatus and closedAt change as normal; the percent stays — only lateness moves the band', async () => {
    const { admin, pendingEstimate } = await seed();
    // Open (pending): no late downgrade while it is open — 92% is excellent.
    const finalized = await request(app).patch(url(pendingEstimate)).set(auth(admin)).send({ assumedPercent: 92 });
    expect(finalized.body.data.performanceRating).toBe('excellent');

    const res = await request(app).patch(`/api/v1/tasks/${pendingEstimate.id}/close`).set(auth(admin));

    expect(res.status).toBe(200);
    const stored = await lean(pendingEstimate);
    // Closed late: the band is computed again from the same 92% — one level down. The real
    // formula (25%, late) would have said "weak" — it was not applied.
    expect(stored).toMatchObject({ status: 'closed', performanceRating: 'good', completionPercent: 25 });
    expect(stored.closedAt).toBeInstanceOf(Date);
    expect(stored.timeStatus.type).toBe('late');
    expect(stored.syntheticRating).toMatchObject({ isSynthetic: true, assumedPercent: 92 });
    expect(Task.getEffectivePercent(stored)).toBe(92);
    // The band change is recorded by 'system' — not an admin edit — and the task stays final.
    expect(stored.syntheticRating.history.at(-1)).toMatchObject({ by: 'system', fromPercent: 92, toPercent: 92, fromRating: 'excellent', toRating: 'good' });
    expect(res.body.data.syntheticRating).toMatchObject({ isFinal: true, isSynthetic: false });
  });

  it('an update to 100% completes the task late: the same percent, one level down', async () => {
    const { admin, assignee, pendingEstimate } = await seed();
    await request(app).patch(url(pendingEstimate)).set(auth(admin)).send({ assumedPercent: 72 });

    await request(app).post(`/api/v1/tasks/${pendingEstimate.id}/updates`).set(auth(assignee)).send({ description: 'مکمل', completionPercent: 100 });

    const stored = await lean(pendingEstimate);
    expect(stored).toMatchObject({ status: 'complete', completionPercent: 100, performanceRating: 'weak' }); // 72% = fair, late
    expect(Task.getEffectivePercent(stored)).toBe(72);
  });

  it('an estimate that was never edited is still replaced by the real rating, exactly as before', async () => {
    const { admin, pendingEstimate } = await seed();
    await request(app).patch(`/api/v1/tasks/${pendingEstimate.id}/close`).set(auth(admin));
    const stored = await lean(pendingEstimate);
    expect(stored.performanceRating).toBe('weak'); // the real 25%, late
    expect(stored.syntheticRating.isSynthetic).toBe(false);
  });
});

describe('consumers — a final rating counts as a real one', () => {
  const summary = async (admin, query = '') => (await request(app).get(`/api/v1/dashboard/summary${query}`).set(auth(admin))).body.data.ratings;
  const codes = async (admin, query) => (await request(app).get(`/api/v1/tasks?sortBy=codeNumber&${query}`).set(auth(admin))).body.data.map((t) => t.codeNumber);

  it('KPIs: syntheticCount counts estimates only; the average uses the final percent', async () => {
    const { admin, closedEstimate } = await seed();
    // Before: two estimates (250126 good 80, 250102 weak 40), one final from history (250103, 95), one real (250104, 50).
    expect(await summary(admin)).toMatchObject({ ratedCount: 4, syntheticCount: 2, averageEffectivePercent: 66.2 });

    await request(app).patch(url(closedEstimate)).set(auth(admin)).send({ assumedPercent: 95 });

    // After: one estimate left. Average (95 + 40 + 95 + 50) / 4 = 70.
    expect(await summary(admin)).toMatchObject({ ratedCount: 4, syntheticCount: 1, averageEffectivePercent: 70, overallQuality: { band: 'fair' } });
  });

  it('ratingSource: synthetic = estimates only; real = real ratings and final ones', async () => {
    const { admin, closedEstimate } = await seed();
    await request(app).patch(url(closedEstimate)).set(auth(admin)).send({ assumedPercent: 95 });

    expect(await codes(admin, 'ratingSource=synthetic')).toEqual(['250102']);
    expect(await codes(admin, 'ratingSource=real')).toEqual(['250103', '250104', '250126']);
    expect((await summary(admin, '?ratingSource=synthetic')).ratedCount).toBe(1);
  });

  it('ratingSource combines with the search (its own $or) and with the rating filter', async () => {
    const { admin } = await seed();
    expect(await codes(admin, 'ratingSource=real&search=250103')).toEqual(['250103']);
    expect(await codes(admin, 'ratingSource=synthetic&search=250103')).toEqual([]);
    expect(await codes(admin, 'ratingSource=real&performanceRating=excellent')).toEqual(['250103']);
  });

  it('user-summary report: the تخمینی column counts estimates only', async () => {
    const { admin, closedEstimate } = await seed();
    await request(app).patch(url(closedEstimate)).set(auth(admin)).send({ assumedPercent: 95 });

    const rows = await reportService.buildUserSummaryData({ id: admin.id, role: 'admin' });

    // 250126 finalized at 95% on a task completed late: good. The legacy final (250103) keeps its
    // stored excellent until the data-fix script corrects it.
    expect(rows.find((r) => r.name === 'Zimmedar')).toMatchObject({ excellent: 1, good: 1, weak: 2, synthetic: 1, total: 4 });
  });
});
