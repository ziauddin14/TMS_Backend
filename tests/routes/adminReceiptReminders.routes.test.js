const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const Notification = require('../../src/models/Notification');
const pushService = require('../../src/services/push.service');
const taskService = require('../../src/services/task.service');
const { NOTIFICATION_TYPES } = require('../../src/utils/notificationTypes');

// POST /admin/trigger-receipt-reminders — the hourly receipt-reminder endpoint
// (.github/workflows/receipt-reminder-cron.yml), and the daily endpoint's receipt backstop.

beforeAll(async () => connect());
beforeEach(() => {
  jest.spyOn(pushService, 'sendPushToUser').mockResolvedValue(undefined);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDatabase();
});
afterAll(async () => closeDatabase());

const HOUR = 60 * 60 * 1000;
function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
}
let n = 0;
async function makeUser(overrides = {}) {
  n += 1;
  return User.create({ name: `User ${n}`, email: `u${n}-${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'user', ...overrides });
}
// A task given to `users` 30 hours ago: reminder 1 is due.
async function overdueReceiptTask(users) {
  const admin = await makeUser({ role: 'admin', name: 'Admin' });
  const task = await taskService.createTask(
    { id: admin.id, role: 'admin', name: admin.name },
    { title: 'T', assignees: users.map((u) => u.id), responsibility: 'R', deadline: new Date(Date.now() + 10 * 24 * HOUR) },
    { withReceipts: true }
  );
  await Task.updateOne({ _id: task.id }, { $set: { 'receipts.$[].assignedAt': new Date(Date.now() - 30 * HOUR) } }, { timestamps: false });
  return { admin, task };
}
const trigger = () => request(app).post('/api/v1/admin/trigger-receipt-reminders').set('X-Cron-Secret', env.CRON_SECRET);
const reminderCount = () => Notification.countDocuments({ type: NOTIFICATION_TYPES.TASK_RECEIPT_REMINDER });

describe('POST /api/v1/admin/trigger-receipt-reminders', () => {
  it('with the cron secret (no session): sends the due reminders and reports them', async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    await overdueReceiptTask([a, b]);

    const res = await trigger();

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ tasksScanned: 1, remindersSent: 2, failures: 0 });
    expect(await reminderCount()).toBe(2);
  });

  it('is idempotent: a second run sends nothing more', async () => {
    await overdueReceiptTask([await makeUser()]);
    await trigger().expect(200);
    const again = await trigger();
    expect(again.body.data.remindersSent).toBe(0);
    expect(await reminderCount()).toBe(1);
  });

  it('is idempotent under OVERLAPPING runs: three requests at once send each reminder once', async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    await overdueReceiptTask([a, b]);

    const results = await Promise.all([trigger(), trigger(), trigger()]);

    results.forEach((res) => expect(res.status).toBe(200));
    expect(results.reduce((sum, res) => sum + res.body.data.remindersSent, 0)).toBe(2);
    expect(await reminderCount()).toBe(2);
  });

  it('only sends receipt reminders — never the daily reminders', async () => {
    const a = await makeUser();
    // Due today, so the DAILY engine would remind about it — this endpoint must not.
    await Task.create({ codeNumber: '250050', title: 'Due', assignees: [a._id], responsibility: 'R', deadline: new Date(), createdBy: a._id });
    await trigger().expect(200);
    expect(await Notification.countDocuments()).toBe(0);
  });

  it('auth: a wrong secret is 401; an Admin session works; a user session is 403', async () => {
    const admin = await makeUser({ role: 'admin' });
    const user = await makeUser();
    const wrong = await request(app).post('/api/v1/admin/trigger-receipt-reminders').set('X-Cron-Secret', 'x'.repeat(40));
    expect(wrong.status).toBe(401);
    const asAdmin = await request(app).post('/api/v1/admin/trigger-receipt-reminders').set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(asAdmin.status).toBe(200);
    const asUser = await request(app).post('/api/v1/admin/trigger-receipt-reminders').set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(asUser.status).toBe(403);
  });
});

describe('POST /api/v1/admin/trigger-reminders — the daily run is the receipt backstop', () => {
  it('runs the receipt pass after the daily engine; `remindersSent` keeps its meaning', async () => {
    await overdueReceiptTask([await makeUser()]);

    const res = await request(app).post('/api/v1/admin/trigger-reminders').set('X-Cron-Secret', env.CRON_SECRET);

    expect(res.status).toBe(200);
    // The task is 10 days from its deadline: nothing for the daily engine; one receipt reminder.
    expect(res.body.data).toEqual({ remindersSent: 0, receiptRemindersSent: 1 });
    expect(await reminderCount()).toBe(1);
  });

  it('a failing receipt pass never fails the daily run', async () => {
    const receiptService = require('../../src/services/receipt.service');
    jest.spyOn(receiptService, 'runReceiptReminders').mockRejectedValue(new Error('boom'));

    const res = await request(app).post('/api/v1/admin/trigger-reminders').set('X-Cron-Secret', env.CRON_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ remindersSent: 0, receiptRemindersSent: null });
  });
});

describe('rate limits — the hourly endpoint has its own counter', () => {
  // The limiter's counts live for the whole file, so this runs last and works from wherever the
  // tests above left them: exhaust the hourly endpoint's limit, then the daily one still answers.
  it('using up the hourly endpoint\'s limit does not touch the daily endpoint\'s', async () => {
    let status = 200;
    for (let i = 0; i < 12 && status !== 429; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ({ status } = await trigger());
    }
    expect(status).toBe(429);

    const daily = await request(app).post('/api/v1/admin/trigger-reminders').set('X-Cron-Secret', env.CRON_SECRET);
    expect(daily.status).toBe(200);
  });
});
