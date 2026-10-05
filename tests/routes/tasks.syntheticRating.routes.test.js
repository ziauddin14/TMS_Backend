const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const TaskUpdate = require('../../src/models/TaskUpdate');
const Notification = require('../../src/models/Notification');

// The synthetic-rating API: what a task response exposes about it (to a user, to an admin), the
// admin-only edit (PATCH) and remove (DELETE) endpoints, and the "synthetic / real" list filter.
beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

const tokenFor = (user) => jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
const auth = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const ASSIGNED_AT = day('2026-10-05');

// A stable hash of a lean task, optionally ignoring some top-level fields.
function fingerprint(doc, omit = []) {
  const copy = { ...doc };
  omit.forEach((key) => delete copy[key]);
  return crypto.createHash('sha256').update(mongoose.mongo.BSON.EJSON.stringify(copy, { relaxed: false })).digest('hex');
}

async function seed() {
  const admin = await User.create({ name: 'Admin', email: `a${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'Admin', role: 'admin' });
  const assignee = await User.create({ name: 'Zimmedar', email: `z${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'user' });
  const outsider = await User.create({ name: 'Other', email: `o${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'user' });
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
  const syn = (assumedPercent, rating) => ({
    isSynthetic: true,
    assumedPercent,
    assignedAt: ASSIGNED_AT,
    assignedBy: 'system:script',
    reason: 'internal reason',
    history: [{ at: ASSIGNED_AT, by: 'system:script', fromPercent: null, toPercent: assumedPercent, fromRating: '-', toRating: rating, note: 'initial synthetic rating' }],
  });
  const [closedSynthetic, pendingSynthetic, realRated, unratedTask] = await Task.create(
    [
      // Closed LATE at a real 0% — its synthetic "good" has no late downgrade.
      base('250101', { status: 'closed', closedAt: day('2025-04-20'), closedBy: admin._id, timeStatus: { type: 'late', days: 20 }, performanceRating: 'good', syntheticRating: syn(80, 'good') }),
      base('250102', { status: 'pending', completionPercent: 25, timeStatus: { type: 'overdue', days: 500 }, performanceRating: 'weak', syntheticRating: syn(40, 'weak') }),
      base('250103', { status: 'closed', closedAt: day('2025-03-20'), closedBy: admin._id, completionPercent: 95, timeStatus: { type: 'early', days: 11 }, performanceRating: 'excellent' }),
      base('250104', { status: 'ongoing', deadline: day('2027-01-01'), timeStatus: { type: 'remaining', days: 400 } }),
    ],
    { timestamps: false, ordered: true }
  );
  return { admin, assignee, outsider, closedSynthetic, pendingSynthetic, realRated, unratedTask };
}
const lean = (task) => Task.findById(task._id).lean();
const url = (task) => `/api/v1/tasks/${task.id}/synthetic-rating`;

describe('task responses — what is exposed about a synthetic rating', () => {
  it('a normal user sees that the rating is synthetic and its assumed percent — but not who assigned it, why, or the history', async () => {
    const { assignee, closedSynthetic } = await seed();

    const res = await request(app).get(`/api/v1/tasks/${closedSynthetic.id}`).set(auth(assignee));

    expect(res.status).toBe(200);
    expect(res.body.data.syntheticRating).toEqual({ isSynthetic: true, assumedPercent: 80, assignedAt: ASSIGNED_AT.toISOString() });
    expect(JSON.stringify(res.body)).not.toMatch(/assignedBy|system:script|internal reason|history/);
    // The real fields are still there, untouched: a closed task at a real 0% rated "good".
    expect(res.body.data).toMatchObject({ status: 'closed', completionPercent: 0, performanceRating: 'good' });
  });

  it('an admin additionally gets the change history — still without assignedBy/reason', async () => {
    const { admin, closedSynthetic } = await seed();

    const res = await request(app).get(`/api/v1/tasks/${closedSynthetic.id}`).set(auth(admin));

    expect(res.body.data.syntheticRating).toEqual({
      isSynthetic: true,
      assumedPercent: 80,
      assignedAt: ASSIGNED_AT.toISOString(),
      history: [{ at: ASSIGNED_AT.toISOString(), by: 'system:script', fromPercent: null, toPercent: 80, fromRating: '-', toRating: 'good', note: 'initial synthetic rating' }],
    });
    expect(res.body.data.syntheticRating).not.toHaveProperty('assignedBy');
    expect(res.body.data.syntheticRating).not.toHaveProperty('reason');
  });

  it('is null on a task that has no synthetic rating (real-rated or unrated)', async () => {
    const { admin, realRated, unratedTask } = await seed();
    const rated = await request(app).get(`/api/v1/tasks/${realRated.id}`).set(auth(admin));
    const unrated = await request(app).get(`/api/v1/tasks/${unratedTask.id}`).set(auth(admin));
    expect(rated.body.data.syntheticRating).toBeNull();
    expect(unrated.body.data.syntheticRating).toBeNull();
  });

  it('the task list carries the same field for every row, by role', async () => {
    const { admin, assignee } = await seed();

    const forUser = await request(app).get('/api/v1/tasks?sortBy=codeNumber').set(auth(assignee));
    const forAdmin = await request(app).get('/api/v1/tasks?sortBy=codeNumber').set(auth(admin));

    expect(forUser.body.data.map((t) => t.syntheticRating && Object.keys(t.syntheticRating).sort())).toEqual([
      ['assignedAt', 'assumedPercent', 'isSynthetic'],
      ['assignedAt', 'assumedPercent', 'isSynthetic'],
      null,
      null,
    ]);
    expect(forAdmin.body.data[0].syntheticRating.history).toHaveLength(1);
  });

  it('the response to posting an update uses the same representation', async () => {
    const { assignee, pendingSynthetic } = await seed();

    const res = await request(app)
      .post(`/api/v1/tasks/${pendingSynthetic.id}/updates`)
      .set(auth(assignee))
      .send({ description: 'کام جاری ہے', completionPercent: 30 });

    expect(res.status).toBe(201);
    expect(res.body.data.task.syntheticRating).toEqual({ isSynthetic: true, assumedPercent: 40, assignedAt: ASSIGNED_AT.toISOString() });
    expect(res.body.data.task.performanceRating).toBe('weak'); // the rule: an update on an open task keeps it
  });
});

describe('GET /tasks?ratingSource= — synthetic / real filter', () => {
  it('synthetic: only tasks whose rating is synthetic; real: only rated tasks that are not', async () => {
    const { admin } = await seed();

    const syntheticOnly = await request(app).get('/api/v1/tasks?ratingSource=synthetic&sortBy=codeNumber').set(auth(admin));
    const realOnly = await request(app).get('/api/v1/tasks?ratingSource=real&sortBy=codeNumber').set(auth(admin));

    expect(syntheticOnly.body.data.map((t) => t.codeNumber)).toEqual(['250101', '250102']);
    expect(realOnly.body.data.map((t) => t.codeNumber)).toEqual(['250103']);
  });

  it('rejects an unknown value', async () => {
    const { admin } = await seed();
    const res = await request(app).get('/api/v1/tasks?ratingSource=bogus').set(auth(admin));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /api/v1/tasks/:id/synthetic-rating — admin edit', () => {
  it('requires authentication', async () => {
    const { closedSynthetic } = await seed();
    const res = await request(app).patch(url(closedSynthetic)).send({ assumedPercent: 90 });
    expect(res.status).toBe(401);
  });

  it('is forbidden for a normal user — even the task\'s own assignee — and changes nothing', async () => {
    const { assignee, closedSynthetic } = await seed();
    const before = await lean(closedSynthetic);

    const res = await request(app).patch(url(closedSynthetic)).set(auth(assignee)).send({ assumedPercent: 100 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
    expect(fingerprint(await lean(closedSynthetic))).toBe(fingerprint(before));
  });

  it('sets the new assumed percent and recomputes the rating from the thresholds — with no late downgrade', async () => {
    const { admin, closedSynthetic } = await seed();

    const res = await request(app).patch(url(closedSynthetic)).set(auth(admin)).send({ assumedPercent: 92, note: 'جائزے کے بعد' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // 92 -> excellent. The task was closed LATE: a real rating would have been downgraded to good.
    expect(res.body.data).toMatchObject({ performanceRating: 'excellent', status: 'closed', completionPercent: 0 });
    expect(res.body.data.syntheticRating).toMatchObject({ isSynthetic: true, assumedPercent: 92, assignedAt: ASSIGNED_AT.toISOString() });
    const stored = await lean(closedSynthetic);
    expect(stored.performanceRating).toBe('excellent');
    expect(stored.syntheticRating).toMatchObject({ isSynthetic: true, assumedPercent: 92, assignedBy: 'system:script', reason: 'internal reason' });
  });

  it.each([
    [100, 'excellent'],
    [90, 'excellent'],
    [89.5, 'good'],
    [80, 'good'],
    [79, 'fair'],
    [70, 'fair'],
    [69, 'weak'],
    [0, 'weak'],
  ])('assumedPercent %s -> %s', async (assumedPercent, rating) => {
    const { admin, pendingSynthetic } = await seed();
    const res = await request(app).patch(url(pendingSynthetic)).set(auth(admin)).send({ assumedPercent });
    expect(res.status).toBe(200);
    expect(res.body.data.performanceRating).toBe(rating);
    expect(res.body.data.status).toBe('pending'); // an open task keeps its status and its rating shows
  });

  it('appends a history entry: who, when, from -> to, and the note', async () => {
    const { admin, closedSynthetic } = await seed();
    const startedAt = Date.now();

    await request(app).patch(url(closedSynthetic)).set(auth(admin)).send({ assumedPercent: 60, note: '  کم کیا گیا  ' });

    const { history } = (await lean(closedSynthetic)).syntheticRating;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ toPercent: 80, note: 'initial synthetic rating' }); // the original entry is kept
    expect(history[1]).toMatchObject({ fromPercent: 80, toPercent: 60, fromRating: 'good', toRating: 'weak', note: 'کم کیا گیا' });
    expect(String(history[1].by)).toBe(admin.id);
    expect(history[1].at.getTime()).toBeGreaterThanOrEqual(startedAt);
  });

  it('touches nothing else on the task: every other field is byte-identical, updatedAt included', async () => {
    const { admin, pendingSynthetic } = await seed();
    const before = await lean(pendingSynthetic);

    await request(app).patch(url(pendingSynthetic)).set(auth(admin)).send({ assumedPercent: 75 });

    const after = await lean(pendingSynthetic);
    expect(fingerprint(after, ['performanceRating', 'syntheticRating'])).toBe(fingerprint(before, ['performanceRating', 'syntheticRating']));
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(after).toMatchObject({ status: 'pending', completionPercent: 25 });
    expect(after.lastUpdateAt.toISOString()).toBe(before.lastUpdateAt.toISOString());
    // Within the subdocument, only the percent and the history moved.
    expect(after.syntheticRating.assignedAt.toISOString()).toBe(before.syntheticRating.assignedAt.toISOString());
    expect(after.syntheticRating).toMatchObject({ isSynthetic: true, assignedBy: 'system:script', reason: 'internal reason' });
  });

  it('creates no TaskUpdate and no notification, and leaves every other task alone', async () => {
    const { admin, closedSynthetic, pendingSynthetic, realRated, unratedTask } = await seed();
    const others = await Promise.all([pendingSynthetic, realRated, unratedTask].map(lean));

    await request(app).patch(url(closedSynthetic)).set(auth(admin)).send({ assumedPercent: 55 });

    expect(await TaskUpdate.countDocuments({})).toBe(0);
    expect(await Notification.countDocuments({})).toBe(0);
    const othersAfter = await Promise.all([pendingSynthetic, realRated, unratedTask].map(lean));
    othersAfter.forEach((doc, index) => expect(fingerprint(doc)).toBe(fingerprint(others[index])));
  });

  it('works on a closed task (which is otherwise read-only)', async () => {
    const { admin, closedSynthetic } = await seed();
    const res = await request(app).patch(url(closedSynthetic)).set(auth(admin)).send({ assumedPercent: 85 });
    expect(res.status).toBe(200);
  });

  it('409 on a task with a REAL rating — a real rating cannot be edited this way', async () => {
    const { admin, realRated } = await seed();
    const before = await lean(realRated);

    const res = await request(app).patch(url(realRated)).set(auth(admin)).send({ assumedPercent: 10 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'NOT_SYNTHETIC_RATING' });
    expect(fingerprint(await lean(realRated))).toBe(fingerprint(before));
  });

  it('409 on an unrated task (it cannot be used to create a synthetic rating)', async () => {
    const { admin, unratedTask } = await seed();
    const res = await request(app).patch(url(unratedTask)).set(auth(admin)).send({ assumedPercent: 80 });
    expect(res.status).toBe(409);
    expect((await lean(unratedTask)).syntheticRating).toBeUndefined();
  });

  it('409 once the synthetic rating has been replaced by a real one', async () => {
    const { admin, pendingSynthetic } = await seed();
    await request(app).patch(`/api/v1/tasks/${pendingSynthetic.id}/close`).set(auth(admin)); // a real close
    expect((await lean(pendingSynthetic)).syntheticRating.isSynthetic).toBe(false);

    const res = await request(app).patch(url(pendingSynthetic)).set(auth(admin)).send({ assumedPercent: 100 });

    expect(res.status).toBe(409);
  });

  it('404 for an unknown or malformed task id', async () => {
    const { admin } = await seed();
    const unknown = await request(app).patch(`/api/v1/tasks/${new mongoose.Types.ObjectId()}/synthetic-rating`).set(auth(admin)).send({ assumedPercent: 50 });
    const malformed = await request(app).patch('/api/v1/tasks/not-an-id/synthetic-rating').set(auth(admin)).send({ assumedPercent: 50 });
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
  });

  it.each([
    ['missing assumedPercent', {}],
    ['below 0', { assumedPercent: -1 }],
    ['above 100', { assumedPercent: 100.5 }],
    ['a numeric string', { assumedPercent: '80' }],
    ['null', { assumedPercent: null }],
    ['an unknown field', { assumedPercent: 80, performanceRating: 'excellent' }],
    ['a note longer than 500 characters', { assumedPercent: 80, note: 'x'.repeat(501) }],
    ['a non-string note', { assumedPercent: 80, note: 5 }],
  ])('400 for %s — and nothing is written', async (_label, body) => {
    const { admin, closedSynthetic } = await seed();
    const before = await lean(closedSynthetic);

    const res = await request(app).patch(url(closedSynthetic)).set(auth(admin)).send(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(fingerprint(await lean(closedSynthetic))).toBe(fingerprint(before));
  });
});

describe('DELETE /api/v1/tasks/:id/synthetic-rating — admin remove', () => {
  it('requires authentication, and is forbidden for a normal user', async () => {
    const { assignee, closedSynthetic } = await seed();
    const before = await lean(closedSynthetic);

    const anonymous = await request(app).delete(url(closedSynthetic));
    const asUser = await request(app).delete(url(closedSynthetic)).set(auth(assignee));

    expect(anonymous.status).toBe(401);
    expect(asUser.status).toBe(403);
    expect(fingerprint(await lean(closedSynthetic))).toBe(fingerprint(before));
  });

  it('puts the task back to unrated: rating "-", marker off, a history entry — and nothing else moves', async () => {
    const { admin, closedSynthetic } = await seed();
    const before = await lean(closedSynthetic);

    const res = await request(app).delete(url(closedSynthetic)).set(auth(admin)).send({ note: 'غلطی سے لگی تھی' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ performanceRating: '-', status: 'closed', completionPercent: 0 });
    expect(res.body.data.syntheticRating).toMatchObject({ isSynthetic: false, assumedPercent: 80 });
    const after = await lean(closedSynthetic);
    expect(after.performanceRating).toBe('-');
    expect(after.syntheticRating.isSynthetic).toBe(false);
    expect(after.syntheticRating.history).toHaveLength(2);
    expect(after.syntheticRating.history[1]).toMatchObject({ fromPercent: 80, toPercent: null, fromRating: 'good', toRating: '-', note: 'غلطی سے لگی تھی' });
    expect(String(after.syntheticRating.history[1].by)).toBe(admin.id);
    expect(fingerprint(after, ['performanceRating', 'syntheticRating'])).toBe(fingerprint(before, ['performanceRating', 'syntheticRating']));
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(await TaskUpdate.countDocuments({})).toBe(0);
    expect(await Notification.countDocuments({})).toBe(0);
  });

  it('works with no request body at all, recording a default note', async () => {
    const { admin, pendingSynthetic } = await seed();

    const res = await request(app).delete(url(pendingSynthetic)).set(auth(admin));

    expect(res.status).toBe(200);
    const after = await lean(pendingSynthetic);
    expect(after.performanceRating).toBe('-');
    expect(after.syntheticRating.history[1].note).toBe('synthetic rating removed');
  });

  it('409 the second time, and 409 on a task that never had a synthetic rating', async () => {
    const { admin, closedSynthetic, realRated } = await seed();
    await request(app).delete(url(closedSynthetic)).set(auth(admin));

    const again = await request(app).delete(url(closedSynthetic)).set(auth(admin));
    const realOne = await request(app).delete(url(realRated)).set(auth(admin));

    expect(again.status).toBe(409);
    expect(realOne.status).toBe(409);
    expect((await lean(realRated)).performanceRating).toBe('excellent');
  });

  it('after removal the task is rated by the real formula like any other (here: a real close)', async () => {
    const { admin, pendingSynthetic } = await seed();
    await request(app).delete(url(pendingSynthetic)).set(auth(admin));

    const res = await request(app).patch(`/api/v1/tasks/${pendingSynthetic.id}/close`).set(auth(admin));

    expect(res.body.data.performanceRating).toBe('weak'); // the real 25%
    expect((await lean(pendingSynthetic)).syntheticRating.history).toHaveLength(2); // no further synthetic history
  });

  it('400 for an unknown field in the body', async () => {
    const { admin, closedSynthetic } = await seed();
    const res = await request(app).delete(url(closedSynthetic)).set(auth(admin)).send({ assumedPercent: 5 });
    expect(res.status).toBe(400);
    expect((await lean(closedSynthetic)).syntheticRating.isSynthetic).toBe(true);
  });
});
