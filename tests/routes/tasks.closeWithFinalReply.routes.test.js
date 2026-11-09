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
const ActivityEvent = require('../../src/models/ActivityEvent');
const activityService = require('../../src/services/activity.service');
const receiptService = require('../../src/services/receipt.service');
const taskService = require('../../src/services/task.service');

// PATCH /tasks/:id/close with an optional final reply (task.service.js closeTaskWithFinalReply):
// the reply and the close in one transaction; never a reopen, no notice, completedAt untouched,
// lateness judged on the date a plain close would use (the reply never makes a task later), the
// rating from the reply's percent; logged as an update entry and then a close entry. Without a
// body the endpoint is the plain close it always was. Through the real API.
beforeAll(async () => connect());
afterEach(async () => {
  await activityService.flushForTests();
  jest.restoreAllMocks();
  await clearDatabase();
});
afterAll(async () => closeDatabase());

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (n) => new Date(Date.now() + n * DAY);
const tokenFor = (user) => jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
const EJSON = (doc) => mongoose.mongo.BSON.EJSON.stringify(doc);

let counter = 0;
async function makeUser(role = 'user') {
  counter += 1;
  return User.create({ name: role === 'admin' ? 'حافظ احمد' : `زید ${counter}`, email: `c${counter}-${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role });
}
// A task completed on time three days ago, due yesterday (the client's case) — override any field.
async function makeTask(admin, assignees, extra = {}) {
  counter += 1;
  return Task.create({
    codeNumber: `2612${String(counter).padStart(2, '0')}`,
    title: 'سالانہ اجلاس کی رپورٹ',
    assignees: assignees.map((user) => user._id),
    responsibility: 'R',
    deadline: daysFromNow(-1),
    createdBy: admin._id,
    status: 'complete',
    completionPercent: 100,
    completedAt: daysFromNow(-3),
    lastUpdateAt: daysFromNow(-3),
    timeStatus: { type: 'early', days: 2 },
    performanceRating: 'excellent',
    ...extra,
  });
}
const close = (user, task, body) => {
  const req = request(app).patch(`/api/v1/tasks/${task.id}/close`).set('Authorization', `Bearer ${tokenFor(user)}`);
  return body === undefined ? req : req.send(body);
};
const reload = (task) => Task.findById(task._id).lean();
const reply = { description: 'حتمی جواب: رپورٹ کا باقی حصہ اگلے اجلاس میں', completionPercent: 70 };
async function activity() {
  await activityService.flushForTests();
  return ActivityEvent.find().sort({ at: 1, _id: 1 }).lean();
}

describe('close with a final reply — the client case: complete on time, deadline passed, reply at 70', () => {
  it('saves the reply and closes in one go: no reopen, no notice, completedAt kept, lateness as a plain close, rating from 70', async () => {
    const admin = await makeUser('admin');
    const a = await makeUser();
    const b = await makeUser();
    const task = await makeTask(admin, [a, b]);
    const twin = await makeTask(admin, [a, b]); // closed without a reply, for comparison
    const before = await reload(task);
    const startedAt = Date.now();

    const res = await close(admin, task, reply);
    await close(admin, twin).expect(200);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'closed', completionPercent: 70, timeStatus: { type: 'early', days: 2 }, performanceRating: 'fair', closedBy: admin.id });

    const stored = await reload(task);
    expect(stored).toMatchObject({ status: 'closed', completionPercent: 70, timeStatus: { type: 'early', days: 2 }, performanceRating: 'fair' });
    expect(stored.completedAt.getTime()).toBe(before.completedAt.getTime()); // neither removed nor moved
    expect(stored.timeStatus).toEqual((await reload(twin)).timeStatus); // the reply did not make it later

    const updates = await TaskUpdate.find({ taskId: task._id }).lean();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ description: reply.description, completionPercent: 70, attachment: null });
    expect(String(updates[0].updatedBy)).toBe(admin.id);
    expect(updates[0].createdAt.getTime()).toBeGreaterThanOrEqual(startedAt);
    // "آخری اپڈیٹ" shows the reply's own date.
    expect(stored.lastUpdateAt.getTime()).toBe(updates[0].createdAt.getTime());

    expect(await Notification.countDocuments()).toBe(0);
  });

  it('logs the update entry, then the close entry — never `reopened` — and the activity list shows them in that order', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    const task = await makeTask(admin, [user]);

    await close(admin, task, reply).expect(200);

    const events = await activity();
    expect(events.map((e) => e.type)).toEqual(['TASK_UPDATE_CREATED', 'TASK_CLOSED']);
    expect(events[0].metadata).toEqual({ taskCode: task.codeNumber, completionPercent: 70, hasAttachment: false });
    expect(events[1].metadata).toEqual({ taskCode: task.codeNumber });
    expect(String(events[0].taskId)).toBe(task.id);

    // Newest first: the close, then the update — even when both carry the same millisecond.
    await ActivityEvent.updateMany({}, { $set: { at: events[0].at } });
    const listed = await request(app).get(`/api/v1/admin/activity/users/${admin.id}/events`).set('Authorization', `Bearer ${tokenFor(admin)}`).expect(200);
    expect(listed.body.data.map((e) => e.type)).toEqual(['TASK_CLOSED', 'TASK_UPDATE_CREATED']);
  });

  it('keeps an attachment on the reply, and the update entry says so', async () => {
    const admin = await makeUser('admin');
    const task = await makeTask(admin, [await makeUser()]);
    const attachment = { driveFileId: 'f1', fileName: 'اجلاس کی رپورٹ.pdf', url: 'https://drive.google.com/file/d/f1/view' };

    await close(admin, task, { ...reply, attachment }).expect(200);

    const [update] = await TaskUpdate.find({ taskId: task._id }).lean();
    expect(update.attachment).toMatchObject(attachment);
    expect((await activity())[0].metadata.hasAttachment).toBe(true);
  });
});

describe('lateness is judged on the date a plain close would use — the reply never makes a task later', () => {
  it('an open overdue task last updated before its deadline: still early, rated from the reply (80 -> good)', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    const open = { status: 'pending', completionPercent: 80, completedAt: undefined, deadline: daysFromNow(-2), lastUpdateAt: daysFromNow(-4), timeStatus: { type: 'overdue', days: 2 }, performanceRating: '-' };
    const task = await makeTask(admin, [user], open);
    const twin = await makeTask(admin, [user], open);

    const res = await close(admin, task, { description: 'آخری حساب', completionPercent: 80 });
    await close(admin, twin).expect(200);

    expect(res.body.data).toMatchObject({ status: 'closed', timeStatus: { type: 'early', days: 2 }, performanceRating: 'good' });
    expect((await reload(twin)).timeStatus).toEqual({ type: 'early', days: 2 });
    // Measured from the reply's own date it would be "late 2" and one level lower.
    expect(taskService.computeTimeStatus({ status: 'closed', deadline: open.deadline, lastUpdateAt: new Date() })).toEqual({ type: 'late', days: 2 });
  });

  it('an open task replied at 100: closed at 100, completedAt still absent (never set), early from its last update', async () => {
    const admin = await makeUser('admin');
    const task = await makeTask(admin, [await makeUser()], {
      status: 'ongoing',
      completionPercent: 60,
      completedAt: undefined,
      deadline: daysFromNow(3),
      lastUpdateAt: daysFromNow(-1),
      timeStatus: { type: 'remaining', days: 3 },
      performanceRating: '-',
    });

    await close(admin, task, { description: 'سب ہو گیا', completionPercent: 100 }).expect(200);

    const stored = await reload(task);
    expect(stored).toMatchObject({ status: 'closed', completionPercent: 100, timeStatus: { type: 'early', days: 4 }, performanceRating: 'excellent' });
    expect(stored).not.toHaveProperty('completedAt');
  });

  it('a task with no update at all: judged on the close itself, exactly like a plain close', async () => {
    const admin = await makeUser('admin');
    const open = { status: 'pending', completionPercent: 0, completedAt: undefined, lastUpdateAt: null, timeStatus: { type: 'overdue', days: 1 }, performanceRating: '-' };
    const task = await makeTask(admin, [await makeUser()], open);
    const twin = await makeTask(admin, [await makeUser()], open);

    const res = await close(admin, task, { description: 'بند', completionPercent: 90 });
    await close(admin, twin).expect(200);

    expect(res.body.data).toMatchObject({ timeStatus: { type: 'late', days: 1 }, performanceRating: 'good' }); // 90 -> excellent, late -> good
    expect((await reload(twin)).timeStatus).toEqual({ type: 'late', days: 1 });
  });
});

describe('ratings at the close', () => {
  const ASSIGNED_AT = new Date('2026-10-05T06:00:00.000Z');
  const script = (percent, rating) => ({ at: ASSIGNED_AT, by: 'system:script', fromPercent: null, toPercent: percent, fromRating: '-', toRating: rating, note: 'initial synthetic rating' });

  it('an ESTIMATE is replaced by the real rating from the reply percent, recorded in its history', async () => {
    const admin = await makeUser('admin');
    const sr = { isSynthetic: true, assumedPercent: 80, assignedAt: ASSIGNED_AT, assignedBy: 'system:script', reason: 'r', history: [script(80, 'good')] };
    const task = await makeTask(admin, [await makeUser()], { performanceRating: 'good', syntheticRating: sr });

    await close(admin, task, { description: 'آخری جواب', completionPercent: 95 }).expect(200);

    const stored = await reload(task);
    expect(stored).toMatchObject({ status: 'closed', performanceRating: 'excellent' });
    expect(stored.syntheticRating.isSynthetic).toBe(false);
    expect(stored.syntheticRating.history.at(-1)).toMatchObject({ fromPercent: 80, toPercent: 95, fromRating: 'good', toRating: 'excellent', note: 'synthetic rating replaced by the real rating — task closed' });
    expect(String(stored.syntheticRating.history.at(-1).by)).toBe(admin.id);
  });

  const final = (admin) => ({
    isSynthetic: true,
    assumedPercent: 90,
    assignedAt: ASSIGNED_AT,
    assignedBy: 'system:script',
    reason: 'r',
    finalizedAt: ASSIGNED_AT,
    finalizedBy: admin._id,
    history: [script(80, 'good'), { at: ASSIGNED_AT, by: admin._id, fromPercent: 80, toPercent: 90, fromRating: 'good', toRating: 'excellent', note: null }],
  });

  it('a FINAL rating keeps its percent and is re-banded with the lateness of a plain close — not the reply date', async () => {
    const admin = await makeUser('admin');
    // Open, overdue, last updated before the deadline: early by a plain close -> stays excellent.
    const task = await makeTask(admin, [await makeUser()], {
      status: 'pending', completionPercent: 40, completedAt: undefined, deadline: daysFromNow(-2), lastUpdateAt: daysFromNow(-3),
      timeStatus: { type: 'overdue', days: 2 }, performanceRating: 'excellent', syntheticRating: final(admin),
    });

    await close(admin, task, { description: 'آخری جواب', completionPercent: 50 }).expect(200);

    const stored = await reload(task);
    expect(stored).toMatchObject({ status: 'closed', completionPercent: 50, timeStatus: { type: 'early', days: 1 }, performanceRating: 'excellent' });
    expect(stored.syntheticRating).toMatchObject({ isSynthetic: true, assumedPercent: 90 });
    expect(stored.syntheticRating.history).toHaveLength(2); // band unchanged: nothing recorded
  });

  it('a FINAL rating on a task that was late by a plain close drops one level, as today', async () => {
    const admin = await makeUser('admin');
    const task = await makeTask(admin, [await makeUser()], {
      status: 'pending', completionPercent: 40, completedAt: undefined, deadline: daysFromNow(-2), lastUpdateAt: daysFromNow(-1),
      timeStatus: { type: 'overdue', days: 2 }, performanceRating: 'excellent', syntheticRating: final(admin),
    });

    await close(admin, task, { description: 'آخری جواب', completionPercent: 50 }).expect(200);

    const stored = await reload(task);
    expect(stored).toMatchObject({ timeStatus: { type: 'late', days: 1 }, performanceRating: 'good' });
    expect(stored.syntheticRating.history.at(-1)).toMatchObject({ by: 'system', fromRating: 'excellent', toRating: 'good', note: `${taskService.FINAL_BAND_NOTE} — task closed` });
  });
});

describe('receipts are never re-armed', () => {
  it('an unconfirmed receipt on a complete task stays exactly as it was, and no reminder goes out after the close', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    const task = await makeTask(admin, [user], { receipts: [{ user: user._id, assignedAt: daysFromNow(-10), assignedBy: admin._id }] });
    const before = await reload(task);

    await close(admin, task, reply).expect(200);

    expect(EJSON((await reload(task)).receipts)).toBe(EJSON(before.receipts));
    const result = await receiptService.runReceiptReminders();
    expect(result.remindersSent).toBe(0);
    expect(await Notification.countDocuments()).toBe(0);
  });
});

describe('refused — nothing is written', () => {
  async function expectUntouched(task, before) {
    expect(EJSON(await reload(task))).toBe(EJSON(before));
    expect(await TaskUpdate.countDocuments({ taskId: task._id })).toBe(0);
    expect(await activity()).toHaveLength(0);
  }

  it.each([
    ['a description under 3 characters', { description: 'ab', completionPercent: 70 }, 'description'],
    ['a blank description', { description: '   ', completionPercent: 70 }, 'description'],
    ['a percent above 100', { description: 'آخری جواب', completionPercent: 101 }, 'completionPercent'],
    ['a percent below 0', { description: 'آخری جواب', completionPercent: -1 }, 'completionPercent'],
    ['a percent without a description', { completionPercent: 70 }, 'description'],
    ['a description without a percent', { description: 'آخری جواب' }, 'completionPercent'],
    ['a malformed attachment', { ...reply, attachment: { driveFileId: 'f1', fileName: 'a.pdf', url: 'not a url' } }, 'attachment.url'],
    ['an unknown field', { ...reply, status: 'complete' }, '(body)'],
  ])('%s: 400 VALIDATION_ERROR', async (_label, body, field) => {
    const admin = await makeUser('admin');
    const task = await makeTask(admin, [await makeUser()]);
    const before = await reload(task);

    const res = await close(admin, task, body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.map((d) => d.field)).toContain(field);
    await expectUntouched(task, before);
  });

  it('an already-closed task: 400 "Yeh kaam close ho chuka hai"', async () => {
    const admin = await makeUser('admin');
    const task = await makeTask(admin, [await makeUser()], { status: 'closed', closedAt: daysFromNow(-1), closedBy: admin._id });
    const before = await reload(task);

    const res = await close(admin, task, reply);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Yeh kaam close ho chuka hai' });
    await expectUntouched(task, before);
  });

  it('a non-admin: 403 FORBIDDEN_ROLE', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    const task = await makeTask(admin, [user]);
    const before = await reload(task);

    const res = await close(user, task, reply);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
    await expectUntouched(task, before);
  });

  it('an unknown task: 404 TASK_NOT_FOUND', async () => {
    const admin = await makeUser('admin');
    const res = await request(app)
      .patch(`/api/v1/tasks/${new mongoose.Types.ObjectId()}/close`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send(reply);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
    expect(await TaskUpdate.countDocuments()).toBe(0);
  });
});

describe('all or nothing', () => {
  it.each([
    ['saving the task fails after the reply was created', () => jest.spyOn(Task.prototype, 'save').mockRejectedValueOnce(new Error('write failed'))],
    ['creating the reply fails', () => jest.spyOn(TaskUpdate, 'create').mockRejectedValueOnce(new Error('write failed'))],
  ])('%s: the transaction is rolled back — no reply, the task as it was, nothing logged', async (_label, fail) => {
    const admin = await makeUser('admin');
    const task = await makeTask(admin, [await makeUser()]);
    const before = await reload(task);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    fail();

    const res = await close(admin, task, reply);

    expect(res.status).toBe(500);
    expect(EJSON(await reload(task))).toBe(EJSON(before));
    expect(await TaskUpdate.countDocuments()).toBe(0);
    expect(await activity()).toHaveLength(0);
    expect(await Notification.countDocuments()).toBe(0);
  });
});

describe('without a body: the plain close, exactly as before', () => {
  it.each([
    ['no body at all', undefined],
    ['an empty body', {}],
  ])('%s: closed from its own percent, no update created, lastUpdateAt untouched, one close entry', async (_label, body) => {
    const admin = await makeUser('admin');
    const task = await makeTask(admin, [await makeUser()]);
    const before = await reload(task);

    const res = await close(admin, task, body);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'closed', completionPercent: 100, timeStatus: { type: 'early', days: 2 }, performanceRating: 'excellent' });
    const stored = await reload(task);
    expect(stored.lastUpdateAt.getTime()).toBe(before.lastUpdateAt.getTime());
    expect(stored.completedAt.getTime()).toBe(before.completedAt.getTime());
    expect(await TaskUpdate.countDocuments()).toBe(0);
    expect((await activity()).map((e) => e.type)).toEqual(['TASK_CLOSED']);
  });
});
