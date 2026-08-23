const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockImplementation(() => ({ sendMail: mockSendMail })),
}));

const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const LookupList = require('../../src/models/LookupList');
const Task = require('../../src/models/Task');
const NotificationLog = require('../../src/models/NotificationLog');
const taskService = require('../../src/services/task.service');
const reminderJob = require('../../src/jobs/reminder.job');

beforeAll(async () => connect());
afterEach(async () => {
  await clearDatabase();
  mockSendMail.mockReset();
});
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
    ...overrides,
  });
}
// Idempotent: makeTask calls this fresh per task, and the (listType, value) unique index rejects
// a second identical insert within the same test — find-or-create rather than assume single-use.
async function makeLookup(value = 'Donation Box Incharge') {
  const existing = await LookupList.findOne({ listType: 'responsibility', value });
  if (existing) return existing;
  return LookupList.create({ listType: 'responsibility', value });
}
function inDays(n) {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}
async function makeTask(admin, assignees, deadlineDays) {
  const lookup = await makeLookup();
  return taskService.createTask(
    { id: admin.id },
    { title: 'X', assignees: assignees.map((u) => u._id), responsibility: lookup.value, deadline: inDays(deadlineDays) }
  );
}

describe('reminder.job — computeTimeStatus reuse and status transition (docs/06-backend.md §8 step 2)', () => {
  it('recomputes a stale timeStatus using the real Phase 5 computeTimeStatus, and saves the correction', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    mockSendMail.mockResolvedValue({});
    const task = await makeTask(admin, [assignee], 10); // freshly created: timeStatus.days = 10

    // Simulate staleness the same way the job would encounter it: deadline edited without a
    // recompute happening in between (the job's whole job is to correct this).
    await Task.findByIdAndUpdate(task.id, { 'timeStatus.days': 999, 'timeStatus.type': 'remaining' });

    await reminderJob.runReminderScan();

    const corrected = await Task.findById(task.id);
    expect(corrected.timeStatus.days).toBe(taskService.computeTimeStatus(corrected).days);
    expect(corrected.timeStatus.days).not.toBe(999);
  });

  it('flips status from "ongoing" to "pending" the moment a task becomes overdue', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    mockSendMail.mockResolvedValue({});
    const task = await makeTask(admin, [assignee], -1); // deadline already passed
    expect((await Task.findById(task.id)).status).toBe('ongoing');

    await reminderJob.runReminderScan();

    const after = await Task.findById(task.id);
    expect(after.status).toBe('pending');
    expect(after.timeStatus.type).toBe('overdue');
  });

  it('does not touch status for a task that is remaining (not yet overdue)', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    mockSendMail.mockResolvedValue({});
    const task = await makeTask(admin, [assignee], 10);

    await reminderJob.runReminderScan();

    expect((await Task.findById(task.id)).status).toBe('ongoing');
  });

  it('leaves an already-"pending" task at "pending" on subsequent runs (no-op on the status field)', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    mockSendMail.mockResolvedValue({});
    const task = await makeTask(admin, [assignee], -1);
    await reminderJob.runReminderScan();
    expect((await Task.findById(task.id)).status).toBe('pending');

    await reminderJob.runReminderScan();

    expect((await Task.findById(task.id)).status).toBe('pending');
  });
});

describe('reminder.job — deadline_soon reminders and dedup', () => {
  it('sends a deadline_soon email when days <= REMINDER_DAYS_BEFORE (2), and logs one NotificationLog entry', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    mockSendMail.mockResolvedValue({});
    const task = await makeTask(admin, [assignee], 1); // 1 day away, REMINDER_DAYS_BEFORE=2

    const { remindersSent } = await reminderJob.runReminderScan();

    expect(remindersSent).toBe(1);
    expect(mockSendMail).toHaveBeenCalled();
    const logs = await NotificationLog.find({ taskId: task._id, type: 'deadline_soon' });
    expect(logs).toHaveLength(1);
  });

  it('does NOT send again on a same-day re-run (dedup)', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    mockSendMail.mockResolvedValue({});
    await makeTask(admin, [assignee], 1);

    const first = await reminderJob.runReminderScan();
    mockSendMail.mockClear();
    const second = await reminderJob.runReminderScan();

    expect(first.remindersSent).toBe(1);
    expect(second.remindersSent).toBe(0);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('does not send when days > REMINDER_DAYS_BEFORE', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    mockSendMail.mockResolvedValue({});
    await makeTask(admin, [assignee], 10);

    const { remindersSent } = await reminderJob.runReminderScan();

    expect(remindersSent).toBe(0);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('emails every assignee plus every active admin, de-duplicated by email', async () => {
    const admin = await makeAdmin();
    const assigneeA = await makeUser();
    const assigneeB = await makeUser();
    mockSendMail.mockResolvedValue({});
    await makeTask(admin, [assigneeA, assigneeB], 1);

    await reminderJob.runReminderScan();

    const recipientEmails = mockSendMail.mock.calls.map((c) => c[0].to).sort();
    expect(recipientEmails).toEqual([admin.email, assigneeA.email, assigneeB.email].sort());
  });
});

describe('reminder.job — overdue reminders and dedup', () => {
  it('sends an overdue email and logs one NotificationLog entry', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    mockSendMail.mockResolvedValue({});
    const task = await makeTask(admin, [assignee], -3);

    const { remindersSent } = await reminderJob.runReminderScan();

    expect(remindersSent).toBe(1);
    const logs = await NotificationLog.find({ taskId: task._id, type: 'overdue' });
    expect(logs).toHaveLength(1);
  });

  it('does NOT send again on a same-day re-run', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    mockSendMail.mockResolvedValue({});
    await makeTask(admin, [assignee], -3);

    await reminderJob.runReminderScan();
    mockSendMail.mockClear();
    const second = await reminderJob.runReminderScan();

    expect(second.remindersSent).toBe(0);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('DOES send again on a later day while still overdue (not deduped across days)', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    mockSendMail.mockResolvedValue({});
    const task = await makeTask(admin, [assignee], -3);

    await reminderJob.runReminderScan();
    expect(await NotificationLog.countDocuments({ taskId: task._id, type: 'overdue' })).toBe(1);

    // Simulate "yesterday's" log entry (a new calendar day has begun) rather than waiting a real day.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await NotificationLog.updateMany({ taskId: task._id, type: 'overdue' }, { sentAt: yesterday });
    mockSendMail.mockClear();

    const { remindersSent } = await reminderJob.runReminderScan();

    expect(remindersSent).toBe(1);
    expect(mockSendMail).toHaveBeenCalled();
    expect(await NotificationLog.countDocuments({ taskId: task._id, type: 'overdue' })).toBe(2);
  });
});

describe('reminder.job — partial-failure resilience', () => {
  it('one failed send does not stop other recipients on the same task from being processed', async () => {
    const admin = await makeAdmin();
    const assigneeA = await makeUser({ email: 'fails@x.com' });
    const assigneeB = await makeUser({ email: 'succeeds@x.com' });
    mockSendMail.mockImplementation(({ to }) =>
      to === 'fails@x.com' ? Promise.reject(new Error('SMTP rejected')) : Promise.resolve({})
    );
    const task = await makeTask(admin, [assigneeA, assigneeB], -1);

    const { remindersSent } = await reminderJob.runReminderScan();

    expect(mockSendMail).toHaveBeenCalledTimes(3); // assigneeA (fails), assigneeB (ok), admin (ok)
    expect(remindersSent).toBe(1); // at least one recipient succeeded -> counted as sent
    expect(await NotificationLog.countDocuments({ taskId: task._id })).toBe(1);
  });

  it('one failed task does not stop other tasks in the same scan from being processed', async () => {
    const admin = await makeAdmin();
    const failingAssignee = await makeUser({ email: 'always-fails@x.com' });
    const okAssignee = await makeUser({ email: 'always-ok@x.com' });
    mockSendMail.mockImplementation(({ to }) =>
      to === 'always-fails@x.com' ? Promise.reject(new Error('SMTP down')) : Promise.resolve({})
    );
    await makeTask(admin, [failingAssignee], -1);
    await makeTask(admin, [okAssignee], -1);

    const { remindersSent, tasksScanned } = await reminderJob.runReminderScan();

    expect(tasksScanned).toBe(2);
    // The failing-assignee task also emails the admin successfully, so it still counts as sent;
    // the key proof is both tasks were scanned and the run completed without throwing.
    expect(remindersSent).toBeGreaterThanOrEqual(1);
  });
});

describe('reminder.job — remindersSent count', () => {
  it('scans only ongoing/pending tasks, ignoring complete/closed ones', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    mockSendMail.mockResolvedValue({});
    await makeTask(admin, [assignee], -1); // ongoing, overdue -> counted
    const closedTask = await makeTask(admin, [assignee], -1);
    await taskService.closeTask({ id: admin.id }, closedTask.id);

    const { tasksScanned } = await reminderJob.runReminderScan();

    expect(tasksScanned).toBe(1);
  });
});
