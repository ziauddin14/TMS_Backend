const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const LookupList = require('../../src/models/LookupList');
const Notification = require('../../src/models/Notification');
const NotificationBatch = require('../../src/models/NotificationBatch');
const taskService = require('../../src/services/task.service');
const notificationService = require('../../src/services/notification.service');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

async function makeAdmin(overrides = {}) {
  return User.create({
    name: 'Admin',
    email: `admin${new mongoose.Types.ObjectId()}@x.com`,
    responsibility: 'Admin',
    role: 'admin',
    ...overrides,
  });
}
async function makeUser(overrides = {}) {
  return User.create({
    name: 'User',
    email: `user${new mongoose.Types.ObjectId()}@x.com`,
    responsibility: 'X',
    role: 'user',
    isActive: true,
    ...overrides,
  });
}
async function makeLookup(value = 'Donation Box Incharge') {
  const existing = await LookupList.findOne({ listType: 'responsibility', value });
  if (existing) return existing;
  return LookupList.create({ listType: 'responsibility', value });
}
async function makeTask(admin, assignees) {
  const lookup = await makeLookup();
  return taskService.createTask(
    { id: admin.id },
    { title: 'X', assignees: assignees.map((u) => u._id), responsibility: lookup.value, deadline: new Date(Date.now() + 5 * 86400000) }
  );
}

describe('notification.service — sendBroadcastToAllUsers (Flow A)', () => {
  it('sends one notification to every active role:"user" account', async () => {
    const admin = await makeAdmin();
    const userA = await makeUser();
    const userB = await makeUser();

    const result = await notificationService.sendBroadcastToAllUsers({
      createdBy: admin.id,
      templateKey: 'GENERAL_REMINDER',
    });

    expect(result.recipientsResolved).toBe(2);
    expect(result.createdCount).toBe(2);
    expect(result.failures).toEqual([]);
    const notifications = await Notification.find({ source: 'admin', type: 'ADMIN_BROADCAST' });
    expect(notifications.map((n) => n.recipientUserId.toString()).sort()).toEqual([userA.id, userB.id].sort());
  });

  it('never includes admins as recipients', async () => {
    const admin = await makeAdmin();
    const otherAdmin = await makeAdmin();
    const user = await makeUser();

    await notificationService.sendBroadcastToAllUsers({ createdBy: admin.id, templateKey: 'GENERAL_REMINDER' });

    const notifications = await Notification.find({ source: 'admin' });
    const recipientIds = notifications.map((n) => n.recipientUserId.toString());
    expect(recipientIds).not.toContain(admin.id);
    expect(recipientIds).not.toContain(otherAdmin.id);
    expect(recipientIds).toEqual([user.id]);
  });

  it('excludes inactive users', async () => {
    const admin = await makeAdmin();
    const active = await makeUser();
    await makeUser({ isActive: false });

    const result = await notificationService.sendBroadcastToAllUsers({ createdBy: admin.id, templateKey: 'GENERAL_REMINDER' });

    expect(result.recipientsResolved).toBe(1);
    const notifications = await Notification.find({ source: 'admin' });
    expect(notifications.map((n) => n.recipientUserId.toString())).toEqual([active.id]);
  });

  it('rejects with 400 NO_ELIGIBLE_RECIPIENTS when there are zero eligible users', async () => {
    const admin = await makeAdmin();

    await expect(
      notificationService.sendBroadcastToAllUsers({ createdBy: admin.id, templateKey: 'GENERAL_REMINDER' })
    ).rejects.toMatchObject({ statusCode: 400, code: 'NO_ELIGIBLE_RECIPIENTS' });
  });

  it('a valid templateKey resolves the registered title and message', async () => {
    const admin = await makeAdmin();
    await makeUser();

    await notificationService.sendBroadcastToAllUsers({ createdBy: admin.id, templateKey: 'URGENT_ATTENTION' });

    const notification = await Notification.findOne({ source: 'admin' });
    expect(notification.title).toBe('فوری توجہ درکار ہے');
    expect(notification.message).toBe('براہ کرم اس معاملے پر فوری توجہ دیں اور صورتحال سے آگاہ کریں۔');
  });

  it('a custom message (no template) is used as-is, with a default title', async () => {
    const admin = await makeAdmin();
    await makeUser();

    await notificationService.sendBroadcastToAllUsers({ createdBy: admin.id, message: 'میرا اپنا پیغام' });

    const notification = await Notification.findOne({ source: 'admin' });
    expect(notification.message).toBe('میرا اپنا پیغام');
    expect(notification.title).toBe('انتظامی پیغام');
  });

  it('template + custom message: the custom message overrides the template message, template still supplies the title', async () => {
    const admin = await makeAdmin();
    await makeUser();

    await notificationService.sendBroadcastToAllUsers({
      createdBy: admin.id,
      templateKey: 'URGENT_ATTENTION',
      message: 'اپنی مرضی کا پیغام',
    });

    const notification = await Notification.findOne({ source: 'admin' });
    expect(notification.title).toBe('فوری توجہ درکار ہے'); // from the template
    expect(notification.message).toBe('اپنی مرضی کا پیغام'); // custom overrides
  });

  it('rejects an unknown templateKey with 400 INVALID_TEMPLATE', async () => {
    const admin = await makeAdmin();
    await makeUser();

    await expect(
      notificationService.sendBroadcastToAllUsers({ createdBy: admin.id, templateKey: 'NOT_A_REAL_TEMPLATE' })
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_TEMPLATE' });
  });

  it('rejects when neither a template nor a message is provided, with 400 MESSAGE_REQUIRED', async () => {
    const admin = await makeAdmin();
    await makeUser();

    await expect(notificationService.sendBroadcastToAllUsers({ createdBy: admin.id })).rejects.toMatchObject({
      statusCode: 400,
      code: 'MESSAGE_REQUIRED',
    });
  });

  it('writes a NotificationBatch audit row with the correct counts', async () => {
    const admin = await makeAdmin();
    await makeUser();
    await makeUser();

    const result = await notificationService.sendBroadcastToAllUsers({ createdBy: admin.id, templateKey: 'GENERAL_REMINDER' });

    const batch = await NotificationBatch.findById(result.batchId);
    expect(batch.recipientMode).toBe('all');
    expect(batch.createdBy.toString()).toBe(admin.id);
    expect(batch.recipientsResolved).toBe(2);
    expect(batch.createdCount).toBe(2);
    expect(batch.targetUserId).toBeNull();
    expect(batch.targetTaskId).toBeNull();
  });
});

describe('notification.service — sendToSpecificUser (Flow B)', () => {
  it('creates exactly one notification for a valid active user', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();

    const result = await notificationService.sendToSpecificUser({
      createdBy: admin.id,
      userId: user.id,
      templateKey: 'GENERAL_REMINDER',
    });

    expect(result.recipientsResolved).toBe(1);
    expect(result.createdCount).toBe(1);
    const notifications = await Notification.find({ recipientUserId: user._id });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('USER_REMINDER');
    expect(notifications[0].taskId).toBeNull();
  });

  it('rejects an inactive user with 400 INVALID_RECIPIENT', async () => {
    const admin = await makeAdmin();
    const inactive = await makeUser({ isActive: false });

    await expect(
      notificationService.sendToSpecificUser({ createdBy: admin.id, userId: inactive.id, templateKey: 'GENERAL_REMINDER' })
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_RECIPIENT' });
    expect(await Notification.countDocuments({})).toBe(0);
  });

  it('rejects an admin as the recipient with 400 INVALID_RECIPIENT', async () => {
    const admin = await makeAdmin();
    const otherAdmin = await makeAdmin();

    await expect(
      notificationService.sendToSpecificUser({ createdBy: admin.id, userId: otherAdmin.id, templateKey: 'GENERAL_REMINDER' })
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_RECIPIENT' });
  });

  it('rejects a nonexistent userId with 400 INVALID_RECIPIENT (not a 500)', async () => {
    const admin = await makeAdmin();

    await expect(
      notificationService.sendToSpecificUser({
        createdBy: admin.id,
        userId: new mongoose.Types.ObjectId().toString(),
        templateKey: 'GENERAL_REMINDER',
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_RECIPIENT' });
  });

  it('rejects a malformed userId with 400 INVALID_RECIPIENT, not a raw CastError', async () => {
    const admin = await makeAdmin();

    await expect(
      notificationService.sendToSpecificUser({ createdBy: admin.id, userId: 'not-an-id', templateKey: 'GENERAL_REMINDER' })
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_RECIPIENT' });
  });

  it('never creates one notification per task — exactly one row regardless of how many tasks the user has', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    await makeTask(admin, [user]);
    await makeTask(admin, [user]);
    await makeTask(admin, [user]);

    await notificationService.sendToSpecificUser({ createdBy: admin.id, userId: user.id, templateKey: 'GENERAL_REMINDER' });

    expect(await Notification.countDocuments({ recipientUserId: user._id })).toBe(1);
  });

  it('writes a NotificationBatch with recipientMode "user" and the correct targetUserId', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();

    const result = await notificationService.sendToSpecificUser({ createdBy: admin.id, userId: user.id, templateKey: 'GENERAL_REMINDER' });

    const batch = await NotificationBatch.findById(result.batchId);
    expect(batch.recipientMode).toBe('user');
    expect(batch.targetUserId.toString()).toBe(user.id);
    expect(batch.targetTaskId).toBeNull();
  });
});

describe('notification.service — sendTaskReminder (Flow C)', () => {
  it('sends one notification to each active assignee', async () => {
    const admin = await makeAdmin();
    const assigneeA = await makeUser();
    const assigneeB = await makeUser();
    const task = await makeTask(admin, [assigneeA, assigneeB]);

    const result = await notificationService.sendTaskReminder({
      createdBy: admin.id,
      taskId: task.id,
      templateKey: 'DEADLINE_APPROACHING',
    });

    expect(result.recipientsResolved).toBe(2);
    expect(result.createdCount).toBe(2);
    const notifications = await Notification.find({ taskId: task._id });
    expect(notifications).toHaveLength(2);
    expect(notifications.every((n) => n.type === 'TASK_REMINDER')).toBe(true);
    expect(notifications.map((n) => n.recipientUserId.toString()).sort()).toEqual([assigneeA.id, assigneeB.id].sort());
  });

  it('excludes an inactive assignee', async () => {
    const admin = await makeAdmin();
    const activeAssignee = await makeUser();
    const toDeactivate = await makeUser();
    const task = await makeTask(admin, [activeAssignee, toDeactivate]);
    // task.service.createTask itself rejects an already-inactive assignee id at creation time —
    // the realistic scenario this proves is a user deactivated AFTER being assigned, not one
    // assigned while already inactive (which the system never allows to happen at all).
    await User.updateOne({ _id: toDeactivate._id }, { isActive: false });

    const result = await notificationService.sendTaskReminder({ createdBy: admin.id, taskId: task.id, templateKey: 'DEADLINE_APPROACHING' });

    expect(result.recipientsResolved).toBe(1);
    const notifications = await Notification.find({ taskId: task._id });
    expect(notifications.map((n) => n.recipientUserId.toString())).toEqual([activeAssignee.id]);
  });

  it('rejects with 400 NO_ELIGIBLE_RECIPIENTS when every assignee is inactive', async () => {
    const admin = await makeAdmin();
    const toDeactivate = await makeUser();
    const task = await makeTask(admin, [toDeactivate]);
    await User.updateOne({ _id: toDeactivate._id }, { isActive: false });

    await expect(
      notificationService.sendTaskReminder({ createdBy: admin.id, taskId: task.id, templateKey: 'DEADLINE_APPROACHING' })
    ).rejects.toMatchObject({ statusCode: 400, code: 'NO_ELIGIBLE_RECIPIENTS' });
  });

  it('rejects a nonexistent taskId with 404 TASK_NOT_FOUND', async () => {
    const admin = await makeAdmin();

    await expect(
      notificationService.sendTaskReminder({
        createdBy: admin.id,
        taskId: new mongoose.Types.ObjectId().toString(),
        templateKey: 'DEADLINE_APPROACHING',
      })
    ).rejects.toMatchObject({ statusCode: 404, code: 'TASK_NOT_FOUND' });
  });

  it('rejects a malformed taskId with 404, not a raw CastError', async () => {
    const admin = await makeAdmin();

    await expect(
      notificationService.sendTaskReminder({ createdBy: admin.id, taskId: 'not-an-id', templateKey: 'DEADLINE_APPROACHING' })
    ).rejects.toMatchObject({ statusCode: 404, code: 'TASK_NOT_FOUND' });
  });

  it('stores the real taskId on every created notification', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const task = await makeTask(admin, [assignee]);

    await notificationService.sendTaskReminder({ createdBy: admin.id, taskId: task.id, templateKey: 'DEADLINE_APPROACHING' });

    const notification = await Notification.findOne({ recipientUserId: assignee._id });
    expect(notification.taskId.toString()).toBe(task.id);
  });

  it('is NOT deduplicated — calling it twice for the same task+assignee creates two notifications, not one', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const task = await makeTask(admin, [assignee]);

    await notificationService.sendTaskReminder({ createdBy: admin.id, taskId: task.id, templateKey: 'DEADLINE_APPROACHING' });
    await notificationService.sendTaskReminder({ createdBy: admin.id, taskId: task.id, templateKey: 'DEADLINE_APPROACHING' });

    expect(await Notification.countDocuments({ recipientUserId: assignee._id, taskId: task._id })).toBe(2);
  });

  it('every created notification has no dedupKey set (admin-sourced, never deduplicated)', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const task = await makeTask(admin, [assignee]);

    await notificationService.sendTaskReminder({ createdBy: admin.id, taskId: task.id, templateKey: 'DEADLINE_APPROACHING' });

    const notification = await Notification.findOne({ recipientUserId: assignee._id });
    expect(notification.dedupKey).toBeUndefined();
  });

  it('writes a NotificationBatch with recipientMode "task" and the correct targetTaskId', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const task = await makeTask(admin, [assignee]);

    const result = await notificationService.sendTaskReminder({ createdBy: admin.id, taskId: task.id, templateKey: 'DEADLINE_APPROACHING' });

    const batch = await NotificationBatch.findById(result.batchId);
    expect(batch.recipientMode).toBe('task');
    expect(batch.targetTaskId.toString()).toBe(task.id);
    expect(batch.targetUserId).toBeNull();
  });

  // Audit Fix #1 — task.service.js's own validateAssignees checks only isActive, not role, so an
  // admin id CAN legitimately end up in task.assignees (via a direct API call bypassing the
  // picker, which never offers one). These tests explicitly construct that exact task state —
  // never assume it can't happen — to prove notification.service.js itself, not task.service.js,
  // is what guarantees "admins never receive manual task reminders."
  describe('role filtering (audit Fix #1 — admins must never receive TASK_REMINDER)', () => {
    it('an active role:"user" assignee receives the reminder', async () => {
      const admin = await makeAdmin();
      const activeUser = await makeUser();
      const task = await makeTask(admin, [activeUser]);

      const result = await notificationService.sendTaskReminder({ createdBy: admin.id, taskId: task.id, templateKey: 'DEADLINE_APPROACHING' });

      expect(result.recipientsResolved).toBe(1);
      expect(result.createdCount).toBe(1);
      const notifications = await Notification.find({ taskId: task._id });
      expect(notifications).toHaveLength(1);
      expect(notifications[0].recipientUserId.toString()).toBe(activeUser.id);
      expect(notifications[0].type).toBe('TASK_REMINDER');
    });

    it('an inactive role:"user" assignee does NOT receive the reminder', async () => {
      const admin = await makeAdmin();
      const toDeactivate = await makeUser();
      const task = await makeTask(admin, [toDeactivate]);
      await User.updateOne({ _id: toDeactivate._id }, { isActive: false });

      await expect(
        notificationService.sendTaskReminder({ createdBy: admin.id, taskId: task.id, templateKey: 'DEADLINE_APPROACHING' })
      ).rejects.toMatchObject({ statusCode: 400, code: 'NO_ELIGIBLE_RECIPIENTS' });
      expect(await Notification.countDocuments({ taskId: task._id })).toBe(0);
    });

    it('an admin assignee does NOT receive the reminder, even though task.service.js allows an admin id in `assignees`', async () => {
      const admin = await makeAdmin();
      const assignedAdmin = await makeAdmin(); // explicitly constructed admin-as-assignee task state
      const task = await makeTask(admin, [assignedAdmin]);
      expect(task.assignees.map((a) => a.id)).toEqual([assignedAdmin.id]); // confirms the task state is real, not assumed impossible

      await expect(
        notificationService.sendTaskReminder({ createdBy: admin.id, taskId: task.id, templateKey: 'DEADLINE_APPROACHING' })
      ).rejects.toMatchObject({ statusCode: 400, code: 'NO_ELIGIBLE_RECIPIENTS' });
      expect(await Notification.countDocuments({ taskId: task._id })).toBe(0);
    });

    it('a mix of active user / inactive user / admin assignees: ONLY the active user receives it, and recipientsResolved reflects that exactly', async () => {
      const admin = await makeAdmin();
      const activeUser = await makeUser();
      const inactiveUser = await makeUser();
      const assignedAdmin = await makeAdmin();
      const task = await makeTask(admin, [activeUser, inactiveUser, assignedAdmin]);
      await User.updateOne({ _id: inactiveUser._id }, { isActive: false });

      const result = await notificationService.sendTaskReminder({ createdBy: admin.id, taskId: task.id, templateKey: 'DEADLINE_APPROACHING' });

      expect(result.recipientsResolved).toBe(1);
      expect(result.createdCount).toBe(1);
      const notifications = await Notification.find({ taskId: task._id });
      expect(notifications).toHaveLength(1);
      expect(notifications[0].recipientUserId.toString()).toBe(activeUser.id);

      const batch = await NotificationBatch.findById(result.batchId);
      expect(batch.recipientsResolved).toBe(1);
      expect(batch.createdCount).toBe(1);
    });
  });
});

describe('notification.service — listAdminHistory', () => {
  it('paginates NotificationBatch directly, newest first', async () => {
    const admin = await makeAdmin();
    const userA = await makeUser();
    const userB = await makeUser();
    await notificationService.sendToSpecificUser({ createdBy: admin.id, userId: userA.id, templateKey: 'GENERAL_REMINDER' });
    await new Promise((r) => setTimeout(r, 5));
    await notificationService.sendToSpecificUser({ createdBy: admin.id, userId: userB.id, templateKey: 'GENERAL_REMINDER' });

    const page1 = await notificationService.listAdminHistory({ page: 1, limit: 1 });

    expect(page1.items).toHaveLength(1);
    expect(page1.meta).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
    expect(page1.items[0].targetUserId.id).toBe(userB.id); // newest first
  });

  it('populates createdBy/targetUserId/targetTaskId', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const task = await makeTask(admin, [assignee]);
    await notificationService.sendTaskReminder({ createdBy: admin.id, taskId: task.id, templateKey: 'DEADLINE_APPROACHING' });

    const { items } = await notificationService.listAdminHistory({ page: 1, limit: 20 });

    expect(items[0].createdBy.name).toBe('Admin');
    expect(items[0].targetTaskId.title).toBe('X');
    expect(items[0].targetTaskId.codeNumber).toBeDefined();
  });
});

// Audit Fix #2 — sendToRecipients' per-recipient try/catch (notification.service.js) was
// previously unexercised by any test. Notification.create is spied on directly (not
// sendToRecipients/createNotification themselves), so these tests run through the REAL loop, the
// REAL try/catch, and the REAL NotificationBatch write — only the underlying DB write for a
// chosen recipient is intercepted. Successful recipients still hit the real, unmocked
// implementation, so their Notification rows are genuinely persisted and independently verified.
describe('notification.service — sendToRecipients partial/total failure isolation (audit Fix #2)', () => {
  let createSpy;

  afterEach(() => {
    if (createSpy) {
      createSpy.mockRestore();
      createSpy = undefined;
    }
  });

  it('CASE A — one recipient failing does not abort the others; failures[] and createdCount both reflect it accurately', async () => {
    const admin = await makeAdmin();
    const okUserA = await makeUser();
    const failingUser = await makeUser();
    const okUserB = await makeUser();

    const originalCreate = Notification.create.bind(Notification);
    createSpy = jest.spyOn(Notification, 'create').mockImplementation((doc) => {
      if (doc.recipientUserId.toString() === failingUser.id) {
        return Promise.reject(new Error('Simulated DB failure for this recipient'));
      }
      return originalCreate(doc);
    });

    const result = await notificationService.sendBroadcastToAllUsers({ createdBy: admin.id, templateKey: 'GENERAL_REMINDER' });

    // Both OK recipients were still processed despite the middle one failing.
    expect(result.recipientsResolved).toBe(3);
    expect(result.createdCount).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ name: 'User', reason: 'Simulated DB failure for this recipient' });
    expect(result.failures[0].recipientUserId.toString()).toBe(failingUser.id);

    // The two successful notifications were genuinely persisted (real DB rows, not just counted).
    const persisted = await Notification.find({ source: 'admin' });
    expect(persisted.map((n) => n.recipientUserId.toString()).sort()).toEqual([okUserA.id, okUserB.id].sort());
    expect(persisted.some((n) => n.recipientUserId.toString() === failingUser.id)).toBe(false);

    // The batch audit row reflects the same accurate counts.
    const batch = await NotificationBatch.findById(result.batchId);
    expect(batch.recipientsResolved).toBe(3);
    expect(batch.createdCount).toBe(2);
    expect(batch.failures).toHaveLength(1);
  });

  it('CASE B — every recipient failing: all are attempted, createdCount is 0, the batch is still written, and the call rejects with NOTIFICATION_CREATION_FAILED (no false partial success)', async () => {
    const admin = await makeAdmin();
    const userA = await makeUser();
    const userB = await makeUser();

    createSpy = jest.spyOn(Notification, 'create').mockRejectedValue(new Error('Simulated total DB outage'));

    await expect(
      notificationService.sendBroadcastToAllUsers({ createdBy: admin.id, templateKey: 'GENERAL_REMINDER' })
    ).rejects.toMatchObject({ statusCode: 500, code: 'NOTIFICATION_CREATION_FAILED' });

    // No partial success was falsely reported — genuinely zero Notification rows exist.
    expect(await Notification.countDocuments({})).toBe(0);

    // The batch was still written (visible in history) even though the whole send ultimately
    // failed — looked up by content since a rejected call never returns a batchId to the caller.
    const batch = await NotificationBatch.findOne({ createdBy: admin.id }).sort({ createdAt: -1 });
    expect(batch).not.toBeNull();
    expect(batch.recipientsResolved).toBe(2);
    expect(batch.createdCount).toBe(0);
    expect(batch.failures).toHaveLength(2);
    expect(batch.failures.map((f) => f.recipientUserId.toString()).sort()).toEqual([userA.id, userB.id].sort());
    expect(batch.failures.every((f) => f.reason === 'Simulated total DB outage')).toBe(true);
  });

  it('CASE B (Flow C variant) — the controller-facing error surfaces correctly for an all-failed task reminder too', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const task = await makeTask(admin, [assignee]);

    createSpy = jest.spyOn(Notification, 'create').mockRejectedValue(new Error('Simulated DB failure'));

    await expect(
      notificationService.sendTaskReminder({ createdBy: admin.id, taskId: task.id, templateKey: 'DEADLINE_APPROACHING' })
    ).rejects.toMatchObject({ statusCode: 500, code: 'NOTIFICATION_CREATION_FAILED' });

    expect(await Notification.countDocuments({ taskId: task._id })).toBe(0);
    const batch = await NotificationBatch.findOne({ targetTaskId: task._id });
    expect(batch.recipientsResolved).toBe(1);
    expect(batch.createdCount).toBe(0);
    expect(batch.failures).toHaveLength(1);
  });
});
