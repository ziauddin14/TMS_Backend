const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const LookupList = require('../../src/models/LookupList');
const Task = require('../../src/models/Task');
const Notification = require('../../src/models/Notification');
const NotificationBatch = require('../../src/models/NotificationBatch');
const taskService = require('../../src/services/task.service');
const emailService = require('../../src/services/email.service');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
}
async function makeAdmin(overrides = {}) {
  return User.create({ name: 'Admin', email: `admin${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'Admin', role: 'admin', ...overrides });
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

describe('POST /api/v1/admin/notifications', () => {
  it('admin can broadcast to all active users (Flow A)', async () => {
    const admin = await makeAdmin();
    await makeUser();
    await makeUser();

    const res = await request(app)
      .post('/api/v1/admin/notifications')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ recipientType: 'all', templateKey: 'GENERAL_REMINDER' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ recipientsResolved: 2, createdCount: 2, failures: [] });
    expect(res.body.data.batchId).toBeDefined();
  });

  it('admin can message a specific Zimmedar (Flow B)', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();

    const res = await request(app)
      .post('/api/v1/admin/notifications')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ recipientType: 'user', userId: user.id, message: 'اپنی مرضی کا پیغام' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ recipientsResolved: 1, createdCount: 1 });
  });

  it('rejects a broadcast with zero eligible recipients (400)', async () => {
    const admin = await makeAdmin();

    const res = await request(app)
      .post('/api/v1/admin/notifications')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ recipientType: 'all', templateKey: 'GENERAL_REMINDER' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_ELIGIBLE_RECIPIENTS');
  });

  it('rejects an unknown template (400 INVALID_TEMPLATE)', async () => {
    const admin = await makeAdmin();
    await makeUser();

    const res = await request(app)
      .post('/api/v1/admin/notifications')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ recipientType: 'all', templateKey: 'MADE_UP' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TEMPLATE');
  });

  it('rejects an empty submission — no template, no message (400 MESSAGE_REQUIRED)', async () => {
    const admin = await makeAdmin();
    await makeUser();

    const res = await request(app)
      .post('/api/v1/admin/notifications')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ recipientType: 'all' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MESSAGE_REQUIRED');
  });

  it('rejects recipientType "user" with no userId at the validator layer (400 VALIDATION_ERROR)', async () => {
    const admin = await makeAdmin();

    const res = await request(app)
      .post('/api/v1/admin/notifications')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ recipientType: 'user', templateKey: 'GENERAL_REMINDER' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an admin id as the Flow B recipient (400 INVALID_RECIPIENT) — a client cannot turn a user recipient into an admin', async () => {
    const admin = await makeAdmin();
    const otherAdmin = await makeAdmin();

    const res = await request(app)
      .post('/api/v1/admin/notifications')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ recipientType: 'user', userId: otherAdmin.id, templateKey: 'GENERAL_REMINDER' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RECIPIENT');
  });

  it('rejects a non-admin (403 FORBIDDEN_ROLE) — a normal user cannot send broadcasts', async () => {
    const user = await makeUser();

    const res = await request(app)
      .post('/api/v1/admin/notifications')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ recipientType: 'all', templateKey: 'GENERAL_REMINDER' });

    expect(res.status).toBe(403);
    expect(await Notification.countDocuments({})).toBe(0);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/v1/admin/notifications').send({ recipientType: 'all' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/admin/tasks/:taskId/reminder', () => {
  it('sends a reminder to every active assignee (Flow C)', async () => {
    const admin = await makeAdmin();
    const assigneeA = await makeUser();
    const assigneeB = await makeUser();
    const task = await makeTask(admin, [assigneeA, assigneeB]);

    const res = await request(app)
      .post(`/api/v1/admin/tasks/${task.id}/reminder`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ templateKey: 'DEADLINE_APPROACHING' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ recipientsResolved: 2, createdCount: 2 });
  });

  it("rejects (400 VALIDATION_ERROR) a request that tries to inject a recipient/userId in the body — the strict schema only accepts templateKey/message, so this class of attempt never even reaches the service layer", async () => {
    const admin = await makeAdmin();
    const realAssignee = await makeUser();
    const attackerTarget = await makeUser();
    const task = await makeTask(admin, [realAssignee]);

    const res = await request(app)
      .post(`/api/v1/admin/tasks/${task.id}/reminder`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ templateKey: 'DEADLINE_APPROACHING', userId: attackerTarget.id, recipientUserId: attackerTarget.id });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(await Notification.countDocuments({})).toBe(0);
  });

  it("a well-formed request (no injected fields) still only ever notifies the task's real assignees, never a client-named id", async () => {
    const admin = await makeAdmin();
    const realAssignee = await makeUser();
    const task = await makeTask(admin, [realAssignee]);

    const res = await request(app)
      .post(`/api/v1/admin/tasks/${task.id}/reminder`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ templateKey: 'DEADLINE_APPROACHING' });

    expect(res.status).toBe(201);
    const notifications = await Notification.find({ taskId: task._id });
    expect(notifications.map((n) => n.recipientUserId.toString())).toEqual([realAssignee.id]);
  });

  it('rejects a task with no eligible active assignees (400)', async () => {
    const admin = await makeAdmin();
    const toDeactivate = await makeUser();
    const task = await makeTask(admin, [toDeactivate]);
    await User.updateOne({ _id: toDeactivate._id }, { isActive: false });

    const res = await request(app)
      .post(`/api/v1/admin/tasks/${task.id}/reminder`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ templateKey: 'DEADLINE_APPROACHING' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_ELIGIBLE_RECIPIENTS');
  });

  it('returns 404 for a nonexistent task', async () => {
    const admin = await makeAdmin();

    const res = await request(app)
      .post(`/api/v1/admin/tasks/${new mongoose.Types.ObjectId()}/reminder`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ templateKey: 'DEADLINE_APPROACHING' });

    expect(res.status).toBe(404);
  });

  it('rejects a non-admin (403) — a normal user cannot send a task reminder', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const nonAdmin = await makeUser();
    const task = await makeTask(admin, [assignee]);

    const res = await request(app)
      .post(`/api/v1/admin/tasks/${task.id}/reminder`)
      .set('Authorization', `Bearer ${tokenFor(nonAdmin)}`)
      .send({ templateKey: 'DEADLINE_APPROACHING' });

    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/admin/notifications/history', () => {
  it('is admin-only', async () => {
    const user = await makeUser();
    const res = await request(app).get('/api/v1/admin/notifications/history').set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/admin/notifications/history');
    expect(res.status).toBe(401);
  });

  it('returns server-side paginated NotificationBatch records with the documented shape', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    await request(app)
      .post('/api/v1/admin/notifications')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ recipientType: 'user', userId: user.id, templateKey: 'GENERAL_REMINDER' });

    const res = await request(app)
      .get('/api/v1/admin/notifications/history')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });
    expect(res.body.data[0]).toMatchObject({
      recipientMode: 'user',
      recipientsResolved: 1,
      createdCount: 1,
      failures: [],
    });
    expect(res.body.data[0].createdBy.name).toBe('Admin');
    expect(res.body.data[0].targetUser.id).toBe(user.id);
  });

  it('paginates directly over NotificationBatch (not a client-side grouping of Notification rows)', async () => {
    const admin = await makeAdmin();
    const userA = await makeUser();
    const userB = await makeUser();
    await request(app)
      .post('/api/v1/admin/notifications')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ recipientType: 'user', userId: userA.id, templateKey: 'GENERAL_REMINDER' });
    await request(app)
      .post('/api/v1/admin/notifications')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ recipientType: 'user', userId: userB.id, templateKey: 'GENERAL_REMINDER' });

    const res = await request(app)
      .get('/api/v1/admin/notifications/history?page=1&limit=1')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.total).toBe(2);
    expect(await NotificationBatch.countDocuments({})).toBe(2);
  });

  it('rejects an out-of-range limit with VALIDATION_ERROR', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/v1/admin/notifications/history?limit=101')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('regression — Phase 3 trigger-reminders endpoint is unaffected by the Phase 2 additions', () => {
  it('POST /admin/trigger-reminders still works exactly as before', async () => {
    const admin = await makeAdmin();
    const res = await request(app).post('/api/v1/admin/trigger-reminders').set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('remindersSent');
  });
});

describe('POST /api/v1/admin/trigger-reminders — Phase 3: now runs the automatic reminder engine (§24 H)', () => {
  it('genuinely creates an automatic notification for an eligible task via the new reminder engine', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user]); // helper's fixed deadline is +5 days — outside the window
    // Put the task in the DUE_TOMORROW window so the trigger has something real to create.
    await Task.findByIdAndUpdate(task.id, { deadline: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000) });

    const res = await request(app)
      .post('/api/v1/admin/trigger-reminders')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.remindersSent).toBe(1);
    const notification = await Notification.findOne({ taskId: task._id, recipientUserId: user._id });
    expect(notification).not.toBeNull();
    expect(notification.type).toBe('TASK_DUE_TOMORROW');
    expect(notification.source).toBe('system');
  });

  it('does not notify an admin assignee, and does not double-notify on a second trigger the same day', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const assignedAdmin = await makeAdmin();
    const task = await makeTask(admin, [user, assignedAdmin]);
    await Task.findByIdAndUpdate(task.id, { deadline: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000) });

    const first = await request(app)
      .post('/api/v1/admin/trigger-reminders')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);
    const second = await request(app)
      .post('/api/v1/admin/trigger-reminders')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);

    expect(first.body.data.remindersSent).toBe(1);
    expect(second.body.data.remindersSent).toBe(0); // already sent today, not re-counted as "sent"
    expect(await Notification.countDocuments({ taskId: task._id, recipientUserId: user._id })).toBe(1);
    expect(await Notification.countDocuments({ taskId: task._id, recipientUserId: assignedAdmin._id })).toBe(0);
  });

  it('sends no email — the new automatic reminder path never calls email.service.js', async () => {
    const soonSpy = jest.spyOn(emailService, 'sendDeadlineSoonEmail');
    const overdueSpy = jest.spyOn(emailService, 'sendOverdueEmail');

    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user]);
    await Task.findByIdAndUpdate(task.id, { deadline: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) });

    await request(app).post('/api/v1/admin/trigger-reminders').set('Authorization', `Bearer ${tokenFor(admin)}`);

    expect(soonSpy).not.toHaveBeenCalled();
    expect(overdueSpy).not.toHaveBeenCalled();
    soonSpy.mockRestore();
    overdueSpy.mockRestore();
  });
});
