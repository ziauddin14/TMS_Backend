const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const Notification = require('../../src/models/Notification');
const NotificationBatch = require('../../src/models/NotificationBatch');
const taskService = require('../../src/services/task.service');
const receiptService = require('../../src/services/receipt.service');
const notificationService = require('../../src/services/notification.service');
const pushService = require('../../src/services/push.service');
const reminderEngineService = require('../../src/services/reminder-engine.service');
const { NOTIFICATION_TYPES } = require('../../src/utils/notificationTypes');

const HOUR = 60 * 60 * 1000;

beforeAll(async () => connect());
beforeEach(() => {
  // No real push in these tests; the spy also lets them count what would have been pushed.
  jest.spyOn(pushService, 'sendPushToUser').mockResolvedValue(undefined);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDatabase();
});
afterAll(async () => closeDatabase());

let counter = 0;
async function makeUser(overrides = {}) {
  counter += 1;
  return User.create({
    name: `صارف ${counter}`,
    email: `u${counter}-${new mongoose.Types.ObjectId()}@x.com`,
    responsibility: 'ذمہ داری',
    role: 'user',
    ...overrides,
  });
}
const makeAdmin = (overrides = {}) => makeUser({ name: 'محمد ضیاء الدین عطاری', role: 'admin', ...overrides });
const actor = (user) => ({ id: user.id, role: user.role, name: user.name });

// A task created the way the app's POST /tasks creates it (opted in to receipts).
async function createViaApp(admin, assignees, overrides = {}) {
  return taskService.createTask(
    actor(admin),
    { title: 'نیا کام', assignees: assignees.map((u) => u.id), responsibility: 'R', deadline: new Date('2026-10-20T00:00:00.000Z'), ...overrides },
    { withReceipts: true }
  );
}
const raw = (id) => Task.collection.findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
const receiptNotices = (userId) =>
  Notification.find({ recipientUserId: userId, type: { $in: [NOTIFICATION_TYPES.TASK_ASSIGNED, NOTIFICATION_TYPES.TASK_RECEIPT_REMINDER] } }).sort({ createdAt: 1 });
const reminders = () => Notification.find({ type: NOTIFICATION_TYPES.TASK_RECEIPT_REMINDER }).sort({ createdAt: 1 });
async function ageReceipts(taskId, hours) {
  const assignedAt = new Date(Date.now() - hours * HOUR);
  await Task.updateOne({ _id: taskId }, { $set: { 'receipts.$[].assignedAt': assignedAt } }, { timestamps: false });
  return assignedAt;
}
const at = (assignedAt, hours) => new Date(assignedAt.getTime() + hours * HOUR);

describe('receipt.service — creating a task through the app', () => {
  it('gives each active role:"user" assignee a receipt and an assignment notice (in-app + push)', async () => {
    const admin = await makeAdmin();
    const [a, b] = [await makeUser(), await makeUser()];

    const task = await createViaApp(admin, [a, b]);

    const stored = await raw(task.id);
    expect(stored.receipts).toHaveLength(2);
    expect(stored.receipts.map((r) => String(r.user))).toEqual([a.id, b.id]);
    stored.receipts.forEach((receipt) => {
      expect(String(receipt.assignedBy)).toBe(admin.id);
      expect(receipt.acknowledgedAt).toBeNull();
      expect(receipt.supersededAt).toBeNull();
      expect(receipt.remindersSent).toEqual([]);
      expect(receipt.notificationId).toBeTruthy();
    });

    const notices = await Notification.find({ type: NOTIFICATION_TYPES.TASK_ASSIGNED }).sort({ createdAt: 1 });
    expect(notices.map((n) => String(n.recipientUserId)).sort()).toEqual([a.id, b.id].sort());
    expect(notices[0].title).toBe('نیا کام سونپا گیا');
    expect(notices[0].message).toBe(
      `محمد ضیاء الدین عطاری نے آپ کو یہ کام سونپا ہے: ${task.codeNumber} — نیا کام، آخری تاریخ 20-10-26۔ براہِ کرم وصول کر لیں۔`
    );
    expect(notices[0].source).toBe('admin');
    expect(String(notices[0].createdBy)).toBe(admin.id);
    expect(String(notices[0].taskId)).toBe(task.id);
    expect(notices[0].metadata.taskCodeNumber).toBe(task.codeNumber);
    expect(pushService.sendPushToUser).toHaveBeenCalledTimes(2);
    // Not a manual admin send: nothing in the admin's notification history.
    expect(await NotificationBatch.countDocuments()).toBe(0);
  });

  it('the deadline in the notice is the Pakistan calendar date, whatever the time of day it is stored at', async () => {
    const admin = await makeAdmin();
    const a = await makeUser();
    // 20:30 UTC on the 20th is already the 21st in Karachi (UTC+5).
    await createViaApp(admin, [a], { deadline: new Date('2026-10-20T20:30:00.000Z') });
    const [notice] = await receiptNotices(a._id);
    expect(notice.message).toContain('آخری تاریخ 21-10-26۔');
  });

  it('no receipt (and no notice) for an admin assignee, nor for a creator who put themselves on the task', async () => {
    const admin = await makeAdmin();
    const otherAdmin = await makeAdmin({ name: 'Other admin' });
    const a = await makeUser();

    const task = await createViaApp(admin, [admin, otherAdmin, a]);

    const stored = await raw(task.id);
    expect(stored.receipts.map((r) => String(r.user))).toEqual([a.id]);
    expect(await Notification.countDocuments({ type: NOTIFICATION_TYPES.TASK_ASSIGNED })).toBe(1);
  });

  it('a task with only ineligible assignees still takes part: an empty receipts list, so a later assignee can get one', async () => {
    const admin = await makeAdmin();
    const task = await createViaApp(admin, [admin]);
    expect((await raw(task.id)).receipts).toEqual([]);
  });

  it('a failed notice is logged and does not fail the task: the task and the other notices are created', async () => {
    const admin = await makeAdmin();
    const [a, b] = [await makeUser(), await makeUser()];
    const real = notificationService.createNotification;
    jest.spyOn(notificationService, 'createNotification').mockImplementation(async (payload) => {
      if (String(payload.recipientUserId) === a.id) throw new Error('database hiccup');
      return real(payload);
    });

    const task = await createViaApp(admin, [a, b]);

    expect(task).toBeTruthy();
    expect((await raw(task.id)).receipts).toHaveLength(2);
    expect(await receiptNotices(a._id)).toHaveLength(0);
    expect(await receiptNotices(b._id)).toHaveLength(1);
  });
});

describe('receipt.service — who does NOT take part', () => {
  it('createTask without the opt-in (any caller other than POST /tasks) creates no receipts and sends nothing', async () => {
    const admin = await makeAdmin();
    const a = await makeUser();
    const task = await taskService.createTask(actor(admin), {
      title: 'T',
      assignees: [a.id],
      responsibility: 'R',
      deadline: new Date('2026-10-20T00:00:00.000Z'),
    });
    expect('receipts' in (await raw(task.id))).toBe(false);
    expect(await Notification.countDocuments()).toBe(0);
  });

  it('a task written directly with Task.create (the import scripts\' path) has no receipts and sends nothing', async () => {
    const admin = await makeAdmin();
    const a = await makeUser();
    const task = await Task.create({ codeNumber: '250001', title: 'Imported', assignees: [a._id], responsibility: 'R', deadline: new Date(), createdBy: admin._id });
    expect('receipts' in (await raw(task.id))).toBe(false);
    expect(await Notification.countDocuments()).toBe(0);
  });

  it('an OLD task stays untouched: the daily engine saves it without adding receipts, the receipt pass ignores it, and there is nothing to confirm', async () => {
    const admin = await makeAdmin();
    const a = await makeUser();
    // Overdue and still "ongoing": the daily engine flips it to pending and saves it.
    const { insertedId } = await Task.collection.insertOne({
      codeNumber: '250002',
      title: 'Old',
      assignees: [a._id],
      responsibility: 'R',
      deadline: new Date(Date.now() - 5 * 24 * HOUR),
      status: 'ongoing',
      completionPercent: 0,
      timeStatus: { type: 'remaining', days: 3 },
      performanceRating: '-',
      createdBy: admin._id,
      createdAt: new Date(Date.now() - 30 * 24 * HOUR),
      updatedAt: new Date(Date.now() - 30 * 24 * HOUR),
    });

    await reminderEngineService.runReminderEngine();
    const afterEngine = await raw(insertedId);
    expect(afterEngine.status).toBe('pending');
    expect('receipts' in afterEngine).toBe(false);

    const pass = await receiptService.runReceiptReminders({ now: new Date(Date.now() + 100 * HOUR) });
    expect(pass.remindersSent).toBe(0);
    await expect(receiptService.acknowledge(actor(a), String(insertedId))).rejects.toMatchObject({ statusCode: 409, code: 'NO_RECEIPT' });
    expect('receipts' in (await raw(insertedId))).toBe(false);
  });
});

describe('receipt.service — acknowledge ("وصول کر لیا")', () => {
  it('records the time on the caller\'s own receipt only, without moving the task\'s updatedAt', async () => {
    const admin = await makeAdmin();
    const [a, b] = [await makeUser(), await makeUser()];
    const task = await createViaApp(admin, [a, b]);
    const before = await raw(task.id);
    const now = new Date(Date.now() + HOUR);

    await receiptService.acknowledge(actor(a), task.id, now);

    const after = await raw(task.id);
    expect(after.receipts.find((r) => String(r.user) === a.id).acknowledgedAt).toEqual(now);
    expect(after.receipts.find((r) => String(r.user) === b.id).acknowledgedAt).toBeNull();
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('is idempotent: confirming again is not an error and keeps the first time', async () => {
    const admin = await makeAdmin();
    const a = await makeUser();
    const task = await createViaApp(admin, [a]);
    const first = new Date(Date.now() + HOUR);

    await receiptService.acknowledge(actor(a), task.id, first);
    await receiptService.acknowledge(actor(a), task.id, new Date(Date.now() + 2 * HOUR));

    expect((await raw(task.id)).receipts[0].acknowledgedAt).toEqual(first);
  });

  it('marks the person\'s own notices about that task read — and nothing else', async () => {
    const admin = await makeAdmin();
    const [a, b] = [await makeUser(), await makeUser()];
    const task = await createViaApp(admin, [a, b]);
    const other = await notificationService.createNotification({
      recipientUserId: a._id, type: NOTIFICATION_TYPES.ADMIN_BROADCAST, title: 'x', message: 'y', source: 'admin', createdBy: admin._id,
    });

    await receiptService.acknowledge(actor(a), task.id);

    const [mine] = await receiptNotices(a._id);
    expect(mine.isRead).toBe(true);
    expect(mine.readAt).toBeInstanceOf(Date);
    expect((await Notification.findById(other._id)).isRead).toBe(false);
    expect((await receiptNotices(b._id))[0].isRead).toBe(false);
  });

  it('someone not on the task gets 403 — an admin included: nobody confirms for anybody else', async () => {
    const admin = await makeAdmin();
    const [a, stranger] = [await makeUser(), await makeUser()];
    const task = await createViaApp(admin, [a]);

    await expect(receiptService.acknowledge(actor(stranger), task.id)).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN_NOT_ASSIGNEE' });
    await expect(receiptService.acknowledge(actor(admin), task.id)).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN_NOT_ASSIGNEE' });
    expect((await raw(task.id)).receipts[0].acknowledgedAt).toBeNull();
  });

  it('an assignee with no receipt (an admin on the task) gets 409 NO_RECEIPT', async () => {
    const admin = await makeAdmin();
    const otherAdmin = await makeAdmin({ name: 'Other admin' });
    const task = await createViaApp(admin, [otherAdmin]);
    await expect(receiptService.acknowledge(actor(otherAdmin), task.id)).rejects.toMatchObject({ statusCode: 409, code: 'NO_RECEIPT' });
  });

  it.each(['closed', 'complete'])('a %s task that was never confirmed can no longer be confirmed (409 TASK_NOT_OPEN)', async (status) => {
    const admin = await makeAdmin();
    const a = await makeUser();
    const task = await createViaApp(admin, [a]);
    await Task.updateOne({ _id: task.id }, { $set: { status } });

    await expect(receiptService.acknowledge(actor(a), task.id)).rejects.toMatchObject({ statusCode: 409, code: 'TASK_NOT_OPEN' });
  });

  it('an unknown or malformed task id is 404', async () => {
    const a = await makeUser();
    await expect(receiptService.acknowledge(actor(a), 'nope')).rejects.toMatchObject({ statusCode: 404 });
    await expect(receiptService.acknowledge(actor(a), String(new mongoose.Types.ObjectId()))).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('receipt.service — reminders (ACK_REMINDER_HOURS = [24, 48])', () => {
  it('the thresholds are the constant [24, 48], counted from the assignment', () => {
    expect(receiptService.ACK_REMINDER_HOURS).toEqual([24, 48]);
    const assignedAt = new Date('2026-10-10T10:00:00.000Z');
    const receipt = (sent = []) => ({ assignedAt, remindersSent: sent.map((level) => ({ level, sentAt: assignedAt })) });
    expect(receiptService.dueLevel(receipt(), at(assignedAt, 23.9))).toBeNull();
    expect(receiptService.dueLevel(receipt(), at(assignedAt, 24))).toBe(1);
    expect(receiptService.dueLevel(receipt(), at(assignedAt, 60))).toBe(1); // lowest level not yet sent
    expect(receiptService.dueLevel(receipt([1]), at(assignedAt, 47))).toBeNull();
    expect(receiptService.dueLevel(receipt([1]), at(assignedAt, 48))).toBe(2);
    expect(receiptService.dueLevel(receipt([1, 2]), at(assignedAt, 500))).toBeNull();
  });

  it('reminder 1 at 24h, reminder 2 at 48h, each exactly once, then never again', async () => {
    const admin = await makeAdmin();
    const a = await makeUser();
    const task = await createViaApp(admin, [a]);
    const assignedAt = await ageReceipts(task.id, 0);

    expect((await receiptService.runReceiptReminders({ now: at(assignedAt, 23) })).remindersSent).toBe(0);
    expect((await receiptService.runReceiptReminders({ now: at(assignedAt, 24) })).remindersSent).toBe(1);
    expect((await receiptService.runReceiptReminders({ now: at(assignedAt, 25) })).remindersSent).toBe(0);
    expect((await receiptService.runReceiptReminders({ now: at(assignedAt, 47) })).remindersSent).toBe(0);
    expect((await receiptService.runReceiptReminders({ now: at(assignedAt, 48) })).remindersSent).toBe(1);
    expect((await receiptService.runReceiptReminders({ now: at(assignedAt, 72) })).remindersSent).toBe(0);
    expect((await receiptService.runReceiptReminders({ now: at(assignedAt, 500) })).remindersSent).toBe(0);

    const sent = await reminders();
    expect(sent.map((n) => n.title)).toEqual(['یاد دہانی: کام وصول کریں', 'دوسری یاد دہانی: کام وصول کریں']);
    expect(sent[0].message).toBe(`${task.codeNumber} — نیا کام، آخری تاریخ 20-10-26۔ براہِ کرم وصول کر لیں۔`);
    sent.forEach((n, i) => {
      expect(n.source).toBe('system');
      expect(n.dedupKey).toBe(`ACK_REMINDER:${task.id}:${(task.receipts[0]._id)}:${i + 1}`);
      expect(n.metadata.taskCodeNumber).toBe(task.codeNumber);
    });
    expect((await raw(task.id)).receipts[0].remindersSent.map((r) => r.level)).toEqual([1, 2]);
    // Two assignment-notice pushes? No: one notice + two reminders, each pushed once.
    expect(pushService.sendPushToUser).toHaveBeenCalledTimes(3);
  });

  it('at most ONE reminder per receipt per run: after a long gap, reminder 1 now and reminder 2 on a later run', async () => {
    const admin = await makeAdmin();
    const a = await makeUser();
    const task = await createViaApp(admin, [a]);
    const assignedAt = await ageReceipts(task.id, 0);

    const first = await receiptService.runReceiptReminders({ now: at(assignedAt, 60) });
    expect(first.remindersSent).toBe(1);
    expect((await reminders()).map((n) => n.metadata.level)).toEqual([1]);

    // A run a few minutes later (the hourly job overlapping the daily backstop) sends nothing...
    expect((await receiptService.runReceiptReminders({ now: at(assignedAt, 60.1) })).remindersSent).toBe(0);
    // ...the next hourly run sends reminder 2.
    expect((await receiptService.runReceiptReminders({ now: at(assignedAt, 61) })).remindersSent).toBe(1);
    expect((await reminders()).map((n) => n.metadata.level)).toEqual([1, 2]);
  });

  it('idempotent under OVERLAPPING runs: two passes at the same moment send each reminder once', async () => {
    const admin = await makeAdmin();
    const [a, b] = [await makeUser(), await makeUser()];
    const task = await createViaApp(admin, [a, b]);
    const assignedAt = await ageReceipts(task.id, 0);
    const now = at(assignedAt, 30);

    const results = await Promise.all([
      receiptService.runReceiptReminders({ now }),
      receiptService.runReceiptReminders({ now }),
      receiptService.runReceiptReminders({ now }),
    ]);

    expect(results.reduce((sum, r) => sum + r.remindersSent, 0)).toBe(2);
    expect(await reminders()).toHaveLength(2);
    expect((await raw(task.id)).receipts.map((r) => r.remindersSent.length)).toEqual([1, 1]);
  });

  it('stops once the receipt is confirmed', async () => {
    const admin = await makeAdmin();
    const a = await makeUser();
    const task = await createViaApp(admin, [a]);
    const assignedAt = await ageReceipts(task.id, 0);
    expect((await receiptService.runReceiptReminders({ now: at(assignedAt, 24) })).remindersSent).toBe(1);

    await receiptService.acknowledge(actor(a), task.id);

    expect((await receiptService.runReceiptReminders({ now: at(assignedAt, 48) })).remindersSent).toBe(0);
  });

  it.each(['closed', 'complete'])('stops on a %s task', async (status) => {
    const admin = await makeAdmin();
    const a = await makeUser();
    const task = await createViaApp(admin, [a]);
    const assignedAt = await ageReceipts(task.id, 0);
    await Task.updateOne({ _id: task.id }, { $set: { status } });

    expect((await receiptService.runReceiptReminders({ now: at(assignedAt, 30) })).remindersSent).toBe(0);
  });

  it('stops for someone taken off the task, and skips an inactive account', async () => {
    const admin = await makeAdmin();
    const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
    const task = await createViaApp(admin, [a, b]);
    const assignedAt = await ageReceipts(task.id, 0);
    // a is taken off (c put on); b is deactivated.
    await taskService.updateTaskFields(task.id, { assignees: [b.id, c.id] }, { actor: actor(admin), withReceipts: true });
    await User.updateOne({ _id: b._id }, { $set: { isActive: false } });
    await Task.updateOne({ _id: task.id }, { $set: { 'receipts.$[r].assignedAt': assignedAt } }, { arrayFilters: [{ 'r.user': { $in: [a._id, b._id] } }], timestamps: false });

    const result = await receiptService.runReceiptReminders({ now: at(assignedAt, 30) });

    // Only c — the one person still on the task and active — is reminded.
    expect(result.remindersSent).toBe(1);
    expect((await reminders()).map((n) => String(n.recipientUserId))).toEqual([c.id]);
  });

  it('a reminder whose notice cannot be created gives its level back, so the next run tries again', async () => {
    const admin = await makeAdmin();
    const a = await makeUser();
    const task = await createViaApp(admin, [a]);
    const assignedAt = await ageReceipts(task.id, 0);
    jest.spyOn(notificationService, 'createSystemNotification').mockRejectedValueOnce(new Error('database hiccup'));

    const failed = await receiptService.runReceiptReminders({ now: at(assignedAt, 24) });
    expect(failed.remindersSent).toBe(0);
    expect(failed.failures).toHaveLength(1);
    expect((await raw(task.id)).receipts[0].remindersSent).toEqual([]);

    expect((await receiptService.runReceiptReminders({ now: at(assignedAt, 25) })).remindersSent).toBe(1);
  });
});

describe('receipt.service — edit / reassign ("ذمہ دار تبدیل کریں")', () => {
  async function setUp() {
    const admin = await makeAdmin();
    const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
    const task = await createViaApp(admin, [a, b]);
    return { admin, a, b, c, task };
  }
  const reassign = (task, users, admin) =>
    taskService.updateTaskFields(task.id, { assignees: users.map((u) => u.id) }, { actor: actor(admin), withReceipts: true });

  it('the new person gets a fresh receipt and the notice; the one taken off is superseded; the one kept is not notified again', async () => {
    const { admin, a, b, c, task } = await setUp();
    const reassigner = await makeAdmin({ name: 'دوسرے ایڈمن' });

    await reassign(task, [b, c], reassigner);

    const stored = await raw(task.id);
    const byUser = (u) => stored.receipts.filter((r) => String(r.user) === u.id);
    expect(byUser(a)[0].supersededAt).toBeInstanceOf(Date);
    expect(byUser(b)).toHaveLength(1);
    expect(byUser(b)[0].supersededAt).toBeNull();
    expect(byUser(c)).toHaveLength(1);
    expect(String(byUser(c)[0].assignedBy)).toBe(reassigner.id);

    expect(await receiptNotices(a._id)).toHaveLength(1);
    expect(await receiptNotices(b._id)).toHaveLength(1);
    const [notice] = await receiptNotices(c._id);
    expect(notice.message.startsWith('دوسرے ایڈمن نے آپ کو یہ کام سونپا ہے:')).toBe(true);
    expect(admin).toBeTruthy();
  });

  it('saving the edit form with the same assignees notifies nobody again', async () => {
    const { admin, a, b, task } = await setUp();
    await taskService.updateTaskFields(task.id, { title: 'نیا عنوان', assignees: [a.id, b.id] }, { actor: actor(admin), withReceipts: true });
    expect(await Notification.countDocuments({ type: NOTIFICATION_TYPES.TASK_ASSIGNED })).toBe(2);
    expect((await raw(task.id)).receipts).toHaveLength(2);
  });

  it('someone taken off and later put back gets a fresh receipt (and a fresh notice)', async () => {
    const { admin, a, b, task } = await setUp();
    await reassign(task, [b], admin);
    await reassign(task, [a, b], admin);

    const mine = (await raw(task.id)).receipts.filter((r) => String(r.user) === a.id);
    expect(mine).toHaveLength(2);
    expect(mine[0].supersededAt).toBeInstanceOf(Date);
    expect(mine[1].supersededAt).toBeNull();
    expect(await receiptNotices(a._id)).toHaveLength(2);
  });

  it('on a COMPLETED task the one taken off is superseded, but nobody new is asked to confirm', async () => {
    const { admin, b, c, task } = await setUp();
    await Task.updateOne({ _id: task.id }, { $set: { status: 'complete' } });
    await reassign(task, [b, c], admin);
    const stored = await raw(task.id);
    expect(stored.receipts.some((r) => String(r.user) === c.id)).toBe(false);
    expect(await receiptNotices(c._id)).toHaveLength(0);
  });

  it('an OLD task (no receipts) gets nothing on reassign', async () => {
    const admin = await makeAdmin();
    const [a, b] = [await makeUser(), await makeUser()];
    const old = await Task.create({ codeNumber: '250003', title: 'Old', assignees: [a._id], responsibility: 'R', deadline: new Date(), createdBy: admin._id });

    await reassign(old, [b], admin);

    expect('receipts' in (await raw(old.id))).toBe(false);
    expect(await Notification.countDocuments()).toBe(0);
  });

  it('without the opt-in (any caller other than PATCH /tasks/:id) receipts are left alone', async () => {
    const { admin, c, task } = await setUp();
    await taskService.updateTaskFields(task.id, { assignees: [c.id] });
    const stored = await raw(task.id);
    expect(stored.receipts.every((r) => r.supersededAt === null)).toBe(true);
    expect(await receiptNotices(c._id)).toHaveLength(0);
    expect(admin).toBeTruthy();
  });
});

describe('receipt.service — receiptStatesForNotifications (the bell)', () => {
  it('gives each assignment notice the CURRENT state of the recipient\'s own receipt, and nothing for other notifications', async () => {
    const admin = await makeAdmin();
    const a = await makeUser();
    const task = await createViaApp(admin, [a]);
    const other = await notificationService.createNotification({
      recipientUserId: a._id, type: NOTIFICATION_TYPES.ADMIN_BROADCAST, title: 'x', message: 'y', source: 'admin', createdBy: admin._id,
    });
    const list = async () => Notification.find({ recipientUserId: a._id });

    let states = await receiptService.receiptStatesForNotifications(a.id, await list());
    const [notice] = await receiptNotices(a._id);
    expect(states.get(notice.id)).toEqual({ acknowledgedAt: null, canAcknowledge: true });
    expect(states.has(other.id)).toBe(false);

    await receiptService.acknowledge(actor(a), task.id);
    states = await receiptService.receiptStatesForNotifications(a.id, await list());
    expect(states.get(notice.id).acknowledgedAt).toBeInstanceOf(Date);
    expect(states.get(notice.id).canAcknowledge).toBe(false);
  });

  it('cannot confirm from the bell once the task is closed', async () => {
    const admin = await makeAdmin();
    const a = await makeUser();
    const task = await createViaApp(admin, [a]);
    await Task.updateOne({ _id: task.id }, { $set: { status: 'closed' } });
    const [notice] = await receiptNotices(a._id);
    const states = await receiptService.receiptStatesForNotifications(a.id, [notice]);
    expect(states.get(notice.id)).toEqual({ acknowledgedAt: null, canAcknowledge: false });
  });
});
