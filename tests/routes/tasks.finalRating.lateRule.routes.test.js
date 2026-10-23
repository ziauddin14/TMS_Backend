const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const taskService = require('../../src/services/task.service');

// The owner's rule for a FINAL rating (an admin changed the estimate): rated exactly like a real
// rating with the percent P the admin entered — the normal thresholds, then ONE level down when the
// task was completed late. While the task is open: no downgrade (it has not been completed yet).
// A rating that is still only an estimate keeps its plain band (no downgrade).
beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

const tokenFor = (user) => jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
const auth = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const LATE = { type: 'late', days: 117 };
const ON_TIME = { type: 'early', days: 3 };

describe('computeFinalRating — the rule (pure)', () => {
  const closed = (timeStatus) => ({ status: 'closed', timeStatus });
  it.each([
    [90, 'good'],
    [80, 'fair'],
    [70, 'weak'],
    [60, 'weak'],
    [95, 'good'],
  ])('%s%% on a task completed late -> %s', (percent, band) => {
    expect(taskService.computeFinalRating(percent, closed(LATE))).toBe(band);
    expect(taskService.computeFinalRating(percent, { status: 'complete', timeStatus: LATE })).toBe(band);
  });

  it.each([
    [90, 'excellent'],
    [80, 'good'],
    [70, 'fair'],
    [60, 'weak'],
  ])('%s%% completed on time -> %s (no downgrade)', (percent, band) => {
    expect(taskService.computeFinalRating(percent, closed(ON_TIME))).toBe(band);
  });

  it('completed exactly on the due date ("early", 0 days) is on time', () => {
    expect(taskService.computeFinalRating(90, closed({ type: 'early', days: 0 }))).toBe('excellent');
  });

  it('an OPEN task — ongoing, or pending and already overdue — gets no downgrade while it is open', () => {
    expect(taskService.computeFinalRating(90, { status: 'pending', timeStatus: { type: 'overdue', days: 40 } })).toBe('excellent');
    expect(taskService.computeFinalRating(80, { status: 'ongoing', timeStatus: { type: 'remaining', days: 4 } })).toBe('good');
  });

  it('reuses the real formula: the same answer as computePerformanceRating with P as the completion percent', () => {
    [0, 55, 69, 70, 79, 80, 89, 90, 100].forEach((p) => {
      [LATE, ON_TIME].forEach((ts) => expect(taskService.computeFinalRating(p, closed(ts))).toBe(taskService.computePerformanceRating(p, ts, 'closed')));
    });
  });
});

describe('PATCH /tasks/:id/synthetic-rating — the stored band of a final rating', () => {
  async function seed() {
    const admin = await User.create({ name: 'Admin', email: `a${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'Admin', role: 'admin' });
    const user = await User.create({ name: 'Zimmedar', email: `z${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'user' });
    const syn = { isSynthetic: true, assumedPercent: 80, assignedAt: day('2026-10-05'), assignedBy: 'system:script', history: [{ at: day('2026-10-05'), by: 'system:script', fromPercent: null, toPercent: 80, fromRating: '-', toRating: 'good', note: 'initial' }] };
    const base = (code, extra) => ({
      codeNumber: code,
      title: `کام ${code}`,
      assignees: [user._id],
      responsibility: 'R',
      deadline: day('2025-03-31'),
      createdBy: admin._id,
      status: 'closed',
      closedAt: day('2025-07-26'),
      closedBy: admin._id,
      lastUpdateAt: day('2025-07-26'),
      completionPercent: 0,
      timeStatus: LATE,
      performanceRating: 'good',
      syntheticRating: syn,
      ...extra,
    });
    const tasks = await Task.create(
      [
        base('250201', { timeStatus: ON_TIME }),
        base('250202'),
        base('250203'),
        base('250204'),
        base('250205'),
        base('250206', { status: 'pending', closedAt: null, closedBy: null, timeStatus: { type: 'overdue', days: 200 }, performanceRating: 'good' }),
        base('250207'), // stays an estimate
      ],
      { ordered: true }
    );
    return { admin, byCode: Object.fromEntries(tasks.map((t) => [t.codeNumber, t])) };
  }
  const finalize = (admin, task, assumedPercent) => request(app).patch(`/api/v1/tasks/${task.id}/synthetic-rating`).set(auth(admin)).send({ assumedPercent });

  it('on time 90 -> ممتاز; late 90 -> بہتر, 80 -> مناسب, 70 -> کمزور, 60 -> کمزور; open overdue 90 -> ممتاز', async () => {
    const { admin, byCode } = await seed();
    const cases = [
      ['250201', 90, 'excellent'],
      ['250202', 90, 'good'],
      ['250203', 80, 'fair'],
      ['250204', 70, 'weak'],
      ['250205', 60, 'weak'],
      ['250206', 90, 'excellent'],
    ];
    for (const [code, percent, band] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const res = await finalize(admin, byCode[code], percent);
      expect([code, res.status, res.body.data.performanceRating]).toEqual([code, 200, band]);
      // eslint-disable-next-line no-await-in-loop
      const stored = await Task.findById(byCode[code]._id).lean();
      expect(stored.performanceRating).toBe(band);
      expect(stored.syntheticRating.assumedPercent).toBe(percent); // P is stored as entered
      expect(stored.syntheticRating.history.at(-1).toRating).toBe(band);
      expect(Task.getEffectivePercent(stored)).toBe(percent);
    }
    // The real completion percent is never touched.
    expect((await Task.find({}).lean()).every((t) => t.completionPercent === 0)).toBe(true);
  });

  it('a rating that is still only an estimate keeps its plain band on a late task (80% -> بہتر)', async () => {
    const { admin, byCode } = await seed();
    const res = await request(app).get(`/api/v1/tasks/${byCode['250207'].id}`).set(auth(admin));
    expect(res.body.data).toMatchObject({ performanceRating: 'good', timeStatus: { type: 'late' }, syntheticRating: { isSynthetic: true, isFinal: false, assumedPercent: 80 } });
  });

  it('the rating filter, the band cards and the average follow: the stored band moves, the effective percent does not', async () => {
    const { admin, byCode } = await seed();
    await finalize(admin, byCode['250202'], 90); // late -> good
    await finalize(admin, byCode['250201'], 90); // on time -> excellent

    const goodCodes = (await request(app).get('/api/v1/tasks?performanceRating=good&sortBy=codeNumber').set(auth(admin))).body.data.map((t) => t.codeNumber);
    expect(goodCodes).toContain('250202');
    const excellentCodes = (await request(app).get('/api/v1/tasks?performanceRating=excellent').set(auth(admin))).body.data.map((t) => t.codeNumber);
    expect(excellentCodes).toEqual(['250201']);

    const { ratings } = (await request(app).get('/api/v1/dashboard/summary').set(auth(admin))).body.data;
    expect(ratings.bands.excellent.count).toBe(1);
    // 7 rated: two finals at 90, five estimates at 80 — the average uses the percents as entered.
    expect(ratings.averageEffectivePercent).toBe(82.8);
    expect(ratings.syntheticCount).toBe(5);
  });
});
