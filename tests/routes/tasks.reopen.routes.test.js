const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const Notification = require('../../src/models/Notification');
const ActivityEvent = require('../../src/models/ActivityEvent');
const activityService = require('../../src/services/activity.service');
const notificationService = require('../../src/services/notification.service');
const taskService = require('../../src/services/task.service');
const { REOPENED_TITLE } = require('../../src/services/taskUpdate.service');
const { formatDateShortKarachi } = require('../../src/utils/formatDate');

// Reopening a completed task, and when a task counts as completed (task.service.js
// applyNewUpdateToTask, computeTimeStatus): any role that may post an update reopens a complete
// task with an update below 100%; completedAt is the date lateness is measured from; the other
// assignees are told; the activity log marks the update. Through the real API.
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
const auth = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });

let counter = 0;
async function makeUser(role = 'user', extra = {}) {
  counter += 1;
  return User.create({ name: role === 'admin' ? 'حافظ احمد' : `زید ${counter}`, email: `u${counter}-${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role, ...extra });
}
// A task completed on time yesterday, due in 5 days — override any field.
async function completeTask(admin, assignees, extra = {}) {
  counter += 1;
  return Task.create({
    codeNumber: `2611${String(counter).padStart(2, '0')}`,
    title: 'گھریلو صدقہ بکس کی پلاننگ',
    assignees: assignees.map((user) => user._id),
    responsibility: 'R',
    deadline: daysFromNow(5),
    createdBy: admin._id,
    status: 'complete',
    completionPercent: 100,
    completedAt: daysFromNow(-1),
    lastUpdateAt: daysFromNow(-1),
    timeStatus: { type: 'early', days: 6 },
    performanceRating: 'excellent',
    ...extra,
  });
}
const post = (user, task, completionPercent, description = 'اپڈیٹ') =>
  request(app).post(`/api/v1/tasks/${task.id}/updates`).set(auth(user)).send({ description, completionPercent });
const reload = (task) => Task.findById(task._id).lean();
const reopenedNotices = () => Notification.find({ type: 'TASK_REOPENED' }).sort({ createdAt: 1 }).lean();

describe('an update below 100% on a complete task reopens it', () => {
  it('deadline still ahead: back to ongoing, an open time status, the rating "-", completedAt cleared', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    const task = await completeTask(admin, [user]);

    const res = await post(admin, task, 0, 'دوبارہ دیکھیں');

    expect(res.status).toBe(201);
    expect(res.body.data.task).toMatchObject({ status: 'ongoing', completionPercent: 0, timeStatus: { type: 'remaining', days: 5 }, performanceRating: '-' });
    const stored = await reload(task);
    expect(stored).toMatchObject({ status: 'ongoing', completionPercent: 0, performanceRating: '-' });
    expect(stored).not.toHaveProperty('completedAt');
  });

  it('deadline already passed (the 261006 case): pending at once and overdue — never "completed late"', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    // Completed by the user on the due date (yesterday), on time.
    const task = await completeTask(admin, [user], { deadline: daysFromNow(-1), timeStatus: { type: 'early', days: 0 } });

    const res = await post(admin, task, 0);

    expect(res.status).toBe(201);
    expect(res.body.data.task).toMatchObject({ status: 'pending', completionPercent: 0, timeStatus: { type: 'overdue', days: 1 }, performanceRating: '-' });
  });

  it('any role may reopen: an assignee posting below 100% reopens the task too', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    const task = await completeTask(admin, [user]);

    await post(user, task, 60).expect(201);

    expect(await reload(task)).toMatchObject({ status: 'ongoing', completionPercent: 60, performanceRating: '-' });
  });

  it('a task left "complete" below 100% by the old code is reopened by its next update below 100%', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    const task = await completeTask(admin, [user], { completionPercent: 0, completedAt: undefined, timeStatus: { type: 'late', days: 1 }, performanceRating: 'weak' });

    await post(admin, task, 10).expect(201);

    expect(await reload(task)).toMatchObject({ status: 'ongoing', completionPercent: 10, performanceRating: '-' });
  });
});

describe('completedAt — lateness is measured from the completion, not from the last update', () => {
  it('the update that completes a task stamps completedAt and is what it is rated against', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    const task = await completeTask(admin, [user], { status: 'ongoing', completionPercent: 40, completedAt: undefined, timeStatus: { type: 'remaining', days: 5 }, performanceRating: '-' });
    const startedAt = Date.now();

    await post(user, task, 100).expect(201);

    const stored = await reload(task);
    expect(stored).toMatchObject({ status: 'complete', timeStatus: { type: 'early', days: 5 }, performanceRating: 'excellent' });
    expect(stored.completedAt.getTime()).toBeGreaterThanOrEqual(startedAt);
    expect(stored.completedAt.getTime()).toBe(stored.lastUpdateAt.getTime());
  });

  it('a repeat 100% after the deadline (a comment) keeps completedAt — and the on-time result', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    const completedAt = daysFromNow(-2);
    const task = await completeTask(admin, [user], { deadline: daysFromNow(-1), completedAt, lastUpdateAt: completedAt, timeStatus: { type: 'early', days: 1 } });

    await post(user, task, 100, 'تصویر شامل کر دی').expect(201);

    const stored = await reload(task);
    expect(stored.completedAt.getTime()).toBe(completedAt.getTime());
    expect(stored.lastUpdateAt.getTime()).toBeGreaterThan(completedAt.getTime()); // "آخری اپڈیٹ" still moves
    expect(stored).toMatchObject({ status: 'complete', timeStatus: { type: 'early', days: 1 }, performanceRating: 'excellent' });
  });

  it('a task completed before completedAt existed keeps its result: its first 100% update stamps its current reference date', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    const lastUpdateAt = daysFromNow(-2);
    const task = await completeTask(admin, [user], { deadline: daysFromNow(-1), completedAt: undefined, lastUpdateAt, timeStatus: { type: 'early', days: 1 } });

    await post(user, task, 100).expect(201);

    const stored = await reload(task);
    expect(stored.completedAt.getTime()).toBe(lastUpdateAt.getTime());
    // Measured from lastUpdateAt (the old rule) it would now be "late 1".
    expect(stored).toMatchObject({ timeStatus: { type: 'early', days: 1 }, performanceRating: 'excellent' });
  });

  it('a task the old code left "complete" at 0%, completed again, is dated by the new completion', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    const task = await completeTask(admin, [user], { deadline: daysFromNow(-1), completionPercent: 0, completedAt: undefined, lastUpdateAt: daysFromNow(-3), timeStatus: { type: 'early', days: 2 }, performanceRating: 'weak' });
    const startedAt = Date.now();

    await post(user, task, 100).expect(201);

    const stored = await reload(task);
    expect(stored.completedAt.getTime()).toBeGreaterThanOrEqual(startedAt);
    expect(stored).toMatchObject({ status: 'complete', timeStatus: { type: 'late', days: 1 }, performanceRating: 'good' });
  });

  it('reopened after the deadline, then completed: late, one level down', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    const task = await completeTask(admin, [user], { deadline: daysFromNow(-1), completedAt: daysFromNow(-2), lastUpdateAt: daysFromNow(-2), timeStatus: { type: 'early', days: 1 } });

    await post(admin, task, 0).expect(201);
    expect(await reload(task)).toMatchObject({ status: 'pending', timeStatus: { type: 'overdue', days: 1 } });
    await post(user, task, 100).expect(201);

    expect(await reload(task)).toMatchObject({ status: 'complete', timeStatus: { type: 'late', days: 1 }, performanceRating: 'good' });
  });

  it('closing a completed task measures lateness from completedAt, not from a later update', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    // Completed on time 2 days ago; a comment today, after the deadline.
    const task = await completeTask(admin, [user], { deadline: daysFromNow(-1), completedAt: daysFromNow(-2), lastUpdateAt: new Date(), timeStatus: { type: 'early', days: 1 } });

    await request(app).patch(`/api/v1/tasks/${task.id}/close`).set(auth(admin)).expect(200);

    expect(await reload(task)).toMatchObject({ status: 'closed', timeStatus: { type: 'early', days: 1 }, performanceRating: 'excellent' });
  });
});

describe('ratings on reopen', () => {
  const ASSIGNED_AT = new Date('2026-10-05T06:00:00.000Z');
  const script = (percent, rating) => ({ at: ASSIGNED_AT, by: 'system:script', fromPercent: null, toPercent: percent, fromRating: '-', toRating: rating, note: 'initial synthetic rating' });

  it('a FINAL rating keeps its percent and goes back to the plain band while open; completed late again, it drops again', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    const sr = {
      isSynthetic: true,
      assumedPercent: 90,
      assignedAt: ASSIGNED_AT,
      assignedBy: 'system:script',
      reason: 'r',
      finalizedAt: ASSIGNED_AT,
      finalizedBy: admin._id,
      history: [script(80, 'good'), { at: ASSIGNED_AT, by: admin._id, fromPercent: 80, toPercent: 90, fromRating: 'good', toRating: 'excellent', note: null }],
    };
    // Completed late (today, due yesterday): 90% -> excellent, one level down -> good.
    const task = await completeTask(admin, [user], { deadline: daysFromNow(-1), completedAt: new Date(), lastUpdateAt: new Date(), timeStatus: { type: 'late', days: 1 }, performanceRating: 'good', syntheticRating: sr });

    const res = await post(admin, task, 0);

    expect(res.body.data.task).toMatchObject({ status: 'pending', performanceRating: 'excellent', syntheticRating: { isFinal: true, assumedPercent: 90 } });
    let stored = await reload(task);
    expect(stored.syntheticRating).toMatchObject({ isSynthetic: true, assumedPercent: 90 });
    expect(stored.syntheticRating.history.at(-1)).toMatchObject({
      by: 'system',
      fromPercent: 90,
      toPercent: 90,
      fromRating: 'good',
      toRating: 'excellent',
      note: `${taskService.FINAL_BAND_NOTE} — task reopened`,
    });
    expect(Task.getEffectivePercent(stored)).toBe(90);

    await post(user, task, 100).expect(201);

    stored = await reload(task);
    expect(stored).toMatchObject({ status: 'complete', timeStatus: { type: 'late', days: 1 }, performanceRating: 'good' });
    expect(stored.syntheticRating.history.at(-1)).toMatchObject({ by: 'system', fromRating: 'excellent', toRating: 'good', note: `${taskService.FINAL_BAND_NOTE} — task completed` });
  });

  it('a rating that is still an ESTIMATE stays exactly as it is', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    const sr = { isSynthetic: true, assumedPercent: 80, assignedAt: ASSIGNED_AT, assignedBy: 'system:script', reason: 'r', history: [script(80, 'good')] };
    const task = await completeTask(admin, [user], { performanceRating: 'good', syntheticRating: sr });

    await post(admin, task, 20).expect(201);

    const stored = await reload(task);
    expect(stored).toMatchObject({ status: 'ongoing', performanceRating: 'good' });
    expect(stored.syntheticRating).toMatchObject({ isSynthetic: true, assumedPercent: 80 });
    expect(stored.syntheticRating.history).toHaveLength(1);
  });
});

describe('the TASK_REOPENED notice', () => {
  it('an admin reopens: every active assignee gets one notice in the approved wording — nobody else', async () => {
    const admin = await makeUser('admin');
    const a = await makeUser();
    const b = await makeUser();
    const inactive = await makeUser('user', { isActive: false });
    const task = await completeTask(admin, [a, b, inactive]);

    await post(admin, task, 0).expect(201);

    const notices = await reopenedNotices();
    expect(notices.map((n) => String(n.recipientUserId)).sort()).toEqual([a.id, b.id].sort());
    const expectedMessage = `حافظ احمد نے یہ کام دوبارہ کھول دیا ہے: ${task.codeNumber} — گھریلو صدقہ بکس کی پلاننگ، آخری تاریخ ${formatDateShortKarachi(task.deadline)}۔`;
    notices.forEach((notice) => {
      expect(notice).toMatchObject({ type: 'TASK_REOPENED', title: 'کام دوبارہ کھول دیا گیا', message: expectedMessage, source: 'admin', metadata: { taskCodeNumber: task.codeNumber } });
      expect(String(notice.taskId)).toBe(task.id);
      expect(String(notice.createdBy)).toBe(admin.id);
    });
    expect(REOPENED_TITLE).toBe('کام دوبارہ کھول دیا گیا');
  });

  it('an assignee reopens: the other assignees are told, the person who reopened it is not', async () => {
    const admin = await makeUser('admin');
    const a = await makeUser();
    const b = await makeUser();
    const task = await completeTask(admin, [a, b]);

    await post(a, task, 50).expect(201);

    const notices = await reopenedNotices();
    expect(notices.map((n) => String(n.recipientUserId))).toEqual([b.id]);
    expect(notices[0]).toMatchObject({ source: 'system', message: expect.stringMatching(new RegExp(`^${a.name} نے یہ کام دوبارہ کھول دیا ہے: `)) });
  });

  it('no notice for an ordinary update, a completion, or a repeat 100%', async () => {
    const admin = await makeUser('admin');
    const a = await makeUser();
    const b = await makeUser();
    const task = await completeTask(admin, [a, b], { status: 'ongoing', completionPercent: 0, completedAt: undefined, timeStatus: { type: 'remaining', days: 5 }, performanceRating: '-' });

    await post(a, task, 50).expect(201);
    await post(a, task, 100).expect(201);
    await post(b, task, 100).expect(201);

    expect(await reopenedNotices()).toHaveLength(0);
  });

  it('a failing notice never fails or undoes the update', async () => {
    const admin = await makeUser('admin');
    const a = await makeUser();
    const task = await completeTask(admin, [a]);
    jest.spyOn(notificationService, 'createNotification').mockRejectedValue(new Error('notification store down'));

    const res = await post(admin, task, 0);

    expect(res.status).toBe(201);
    expect(await reload(task)).toMatchObject({ status: 'ongoing', completionPercent: 0 });
    expect(await reopenedNotices()).toHaveLength(0);
  });
});

describe('the activity log', () => {
  it('the update that reopens carries reopened:true; any other update carries no such key', async () => {
    const admin = await makeUser('admin');
    const a = await makeUser();
    const task = await completeTask(admin, [a]);

    await post(admin, task, 0).expect(201);
    await post(a, task, 30).expect(201);
    await activityService.flushForTests();

    const events = await ActivityEvent.find({ type: 'TASK_UPDATE_CREATED' }).sort({ at: 1, _id: 1 }).lean();
    expect(events.map((e) => e.metadata)).toEqual([
      { taskCode: task.codeNumber, completionPercent: 0, hasAttachment: false, reopened: true },
      { taskCode: task.codeNumber, completionPercent: 30, hasAttachment: false },
    ]);
  });
});

describe('the rules themselves (pure)', () => {
  const deadline = new Date('2026-10-21T12:00:00.000Z');

  it('computeTimeStatus: completedAt first, then lastUpdateAt, closedAt, updatedAt', () => {
    const base = { status: 'complete', deadline, lastUpdateAt: new Date('2026-10-22T12:00:00.000Z') };
    expect(taskService.computeTimeStatus({ ...base, completedAt: new Date('2026-10-20T12:00:00.000Z') })).toEqual({ type: 'early', days: 1 });
    expect(taskService.computeTimeStatus(base)).toEqual({ type: 'late', days: 1 });
    expect(taskService.completionReferenceDate({ closedAt: deadline, updatedAt: new Date() })).toBe(deadline);
  });

  it('applyOverdueRule: only an overdue ongoing task becomes pending', () => {
    const run = (task) => [taskService.applyOverdueRule(task), task.status];
    expect(run({ status: 'ongoing', timeStatus: { type: 'overdue', days: 1 } })).toEqual([true, 'pending']);
    expect(run({ status: 'ongoing', timeStatus: { type: 'remaining', days: 0 } })).toEqual([false, 'ongoing']);
    expect(run({ status: 'pending', timeStatus: { type: 'overdue', days: 3 } })).toEqual([false, 'pending']);
    expect(run({ status: 'complete', timeStatus: { type: 'late', days: 3 } })).toEqual([false, 'complete']);
  });
});
