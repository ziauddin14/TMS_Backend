const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const LookupList = require('../../src/models/LookupList');
const Task = require('../../src/models/Task');
const Notification = require('../../src/models/Notification');
const taskService = require('../../src/services/task.service');
const notificationService = require('../../src/services/notification.service');
const reminderEngineService = require('../../src/services/reminder-engine.service');
const { NOTIFICATION_TYPES } = require('../../src/utils/notificationTypes');

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
function inDays(n) {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}
async function makeTask(admin, assignees, deadlineDaysOrDate) {
  const lookup = await makeLookup();
  const deadline = deadlineDaysOrDate instanceof Date ? deadlineDaysOrDate : inDays(deadlineDaysOrDate);
  return taskService.createTask(
    { id: admin.id },
    { title: 'X', assignees: assignees.map((u) => u._id), responsibility: lookup.value, deadline }
  );
}

describe('reminder-engine.service — classification (Phase 3 §7/§24 A/B)', () => {
  it('an overdue task -> TASK_OVERDUE, and only TASK_OVERDUE (precedence)', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user], -3);

    await reminderEngineService.runReminderEngine();

    const notifications = await Notification.find({ taskId: task._id, recipientUserId: user._id });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe(NOTIFICATION_TYPES.TASK_OVERDUE);
  });

  it('exactly 1 day remaining -> TASK_DUE_TOMORROW, and only TASK_DUE_TOMORROW (precedence)', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user], 1);

    await reminderEngineService.runReminderEngine();

    const notifications = await Notification.find({ taskId: task._id, recipientUserId: user._id });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe(NOTIFICATION_TYPES.TASK_DUE_TOMORROW);
  });

  it('2 days remaining (within REMINDER_DAYS_BEFORE=2) -> TASK_DUE_SOON', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user], 2);

    await reminderEngineService.runReminderEngine();

    const notifications = await Notification.find({ taskId: task._id, recipientUserId: user._id });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe(NOTIFICATION_TYPES.TASK_DUE_SOON);
  });

  it('outside the reminder window (5 days remaining) -> no automatic notification', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user], 5);

    const summary = await reminderEngineService.runReminderEngine();

    expect(summary.notificationsCreated).toBe(0);
    expect(await Notification.countDocuments({ taskId: task._id })).toBe(0);
  });

  // Production-incident regression test (task 260906, 2026-09-25): this used to assert
  // notificationsCreated:0 here — that was the bug itself, not a passing spec. A due-today task
  // must now genuinely produce a distinct TASK_DUE_TODAY notification, same as the other three
  // automatic types.
  it('deadline is today (0 days remaining, not yet overdue) -> TASK_DUE_TODAY, and only TASK_DUE_TODAY (precedence)', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user], 0);

    const summary = await reminderEngineService.runReminderEngine();

    expect(summary.notificationsCreated).toBe(1);
    const notifications = await Notification.find({ taskId: task._id, recipientUserId: user._id });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe(NOTIFICATION_TYPES.TASK_DUE_TODAY);
    expect(notifications[0].message).not.toBe(
      'اس کام کی آخری تاریخ کل ہے۔' // must not reuse TASK_DUE_TOMORROW's wording — deadline is today, not tomorrow
    );
  });
});

describe('reminder-engine.service — recipient resolution (Phase 3 §9/§24 C)', () => {
  it('an active role:"user" assignee receives the reminder', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user], 1);

    await reminderEngineService.runReminderEngine();

    expect(await Notification.countDocuments({ taskId: task._id, recipientUserId: user._id })).toBe(1);
  });

  it('an inactive assignee does NOT receive the reminder', async () => {
    const admin = await makeAdmin();
    const inactiveUser = await makeUser(); // active at creation — validateAssignees requires it
    // task.service.js's validateAssignees rejects inactive assignees at creation time, so this
    // task state is constructed the same way the Phase 2 audit did (fresh valid task, then flip
    // the assignee inactive afterward) — a real, reachable state: a user can be deactivated after
    // being assigned to a task.
    const task = await makeTask(admin, [inactiveUser], 1);
    await User.findByIdAndUpdate(inactiveUser.id, { isActive: false });

    const summary = await reminderEngineService.runReminderEngine();

    expect(summary.notificationsCreated).toBe(0);
    expect(await Notification.countDocuments({ taskId: task._id })).toBe(0);
  });

  it('an admin assignee does NOT receive the automatic reminder, even though task.service.js allows an admin id in `assignees`', async () => {
    const admin = await makeAdmin();
    const assignedAdmin = await makeAdmin();
    const task = await makeTask(admin, [assignedAdmin], 1);
    expect(task.assignees.map((a) => a.id)).toEqual([assignedAdmin.id]); // the task state is real, not assumed impossible

    const summary = await reminderEngineService.runReminderEngine();

    expect(summary.notificationsCreated).toBe(0);
    expect(await Notification.countDocuments({ taskId: task._id })).toBe(0);
  });

  it('a mix of active user / inactive user / admin assignees: ONLY the active user receives it', async () => {
    const admin = await makeAdmin();
    const activeUser = await makeUser();
    const inactiveUser = await makeUser();
    const assignedAdmin = await makeAdmin();
    const task = await makeTask(admin, [activeUser, inactiveUser, assignedAdmin], 1);
    await User.findByIdAndUpdate(inactiveUser.id, { isActive: false });

    const summary = await reminderEngineService.runReminderEngine();

    expect(summary.notificationsCreated).toBe(1);
    const notifications = await Notification.find({ taskId: task._id });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].recipientUserId.toString()).toBe(activeUser.id);
  });
});

describe('reminder-engine.service — atomic deduplication (Phase 3 §11-§14/§24 D/§25)', () => {
  it('CASE 1 — same task + same recipient + same day -> exactly one notification across two scans', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user], 1);

    const first = await reminderEngineService.runReminderEngine();
    const second = await reminderEngineService.runReminderEngine();

    expect(first.notificationsCreated).toBe(1);
    expect(second.notificationsCreated).toBe(0);
    expect(second.notificationsAlreadySent).toBe(1);
    expect(await Notification.countDocuments({ taskId: task._id, recipientUserId: user._id })).toBe(1);
  });

  // §25 — a REAL concurrency test: two full scans launched together, not a mocked dedup check.
  // The unique sparse { dedupKey: 1 } index on Notification is the sole authority here (locked
  // blueprint §12) — at least one of the two attempts must hit the expected E11000 duplicate and
  // be handled as a no-op, never surfaced as an application error or a second document.
  it('CASE 2 — two concurrent scans for the exact same task/recipient/Pakistan-day still produce exactly one notification', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const now = new Date();
    const task = await makeTask(admin, [user], 1);

    const [a, b] = await Promise.all([
      reminderEngineService.runReminderEngine({ now }),
      reminderEngineService.runReminderEngine({ now }),
    ]);

    const totalCreated = a.notificationsCreated + b.notificationsCreated;
    const totalAlreadySent = a.notificationsAlreadySent + b.notificationsAlreadySent;
    expect(totalCreated).toBe(1);
    expect(totalAlreadySent).toBe(1);
    expect(a.failures).toHaveLength(0);
    expect(b.failures).toHaveLength(0);

    const dedupKey = `AUTO_REMINDER:${task._id}:${user._id}:${taskService.getPakistanDateString(now)}`;
    expect(await Notification.countDocuments({ taskId: task._id, recipientUserId: user._id, dedupKey })).toBe(1);
  });

  it('CASE 3 — reclassified from DUE_TOMORROW to OVERDUE later the same Pakistan day still yields exactly one notification (first-writer-wins)', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user], 1); // due tomorrow

    const first = await reminderEngineService.runReminderEngine();
    expect(first.notificationsCreated).toBe(1);

    // Same Pakistan calendar day, task now overdue (deadline edited into the past) — a realistic
    // same-day re-scan scenario.
    await Task.findByIdAndUpdate(task.id, { deadline: inDays(-3) });

    const second = await reminderEngineService.runReminderEngine();

    expect(second.notificationsCreated).toBe(0);
    expect(second.notificationsAlreadySent).toBe(1);

    const notifications = await Notification.find({ taskId: task._id, recipientUserId: user._id });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe(NOTIFICATION_TYPES.TASK_DUE_TOMORROW); // not overwritten to OVERDUE

    // State maintenance is unaffected by the dedup outcome — the task itself did flip to overdue.
    const updatedTask = await Task.findById(task.id);
    expect(updatedTask.status).toBe('pending');
    expect(updatedTask.timeStatus.type).toBe('overdue');
  });

  it('CASE 4 — same task, different recipients -> one notification per recipient', async () => {
    const admin = await makeAdmin();
    const userA = await makeUser();
    const userB = await makeUser();
    const task = await makeTask(admin, [userA, userB], 1);

    const summary = await reminderEngineService.runReminderEngine();

    expect(summary.notificationsCreated).toBe(2);
    expect(await Notification.countDocuments({ taskId: task._id, recipientUserId: userA._id })).toBe(1);
    expect(await Notification.countDocuments({ taskId: task._id, recipientUserId: userB._id })).toBe(1);
  });

  it('CASE 5 — same recipient, different tasks -> independent notifications', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const taskA = await makeTask(admin, [user], 1);
    const taskB = await makeTask(admin, [user], 1);

    const summary = await reminderEngineService.runReminderEngine();

    expect(summary.notificationsCreated).toBe(2);
    expect(await Notification.countDocuments({ taskId: taskA._id, recipientUserId: user._id })).toBe(1);
    expect(await Notification.countDocuments({ taskId: taskB._id, recipientUserId: user._id })).toBe(1);
  });

  // CASE 6 also demonstrates §5/§24 E: the dedupKey's date component is the explicit Karachi
  // calendar date, built via taskService.getPakistanDateString — not whatever the host's own
  // clock/timezone would produce.
  it('CASE 6 — same task + recipient, but the next Pakistan calendar day -> a new notification is allowed', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    // Deadline chosen so the task is overdue on both simulated days — isolates this test to the
    // dedupKey's date component, not to a classification change.
    const deadline = new Date(Date.UTC(2026, 8, 10, 8, 0, 0));
    const task = await makeTask(admin, [user], deadline);

    const day1 = new Date(Date.UTC(2026, 8, 15, 12, 0, 0)); // Karachi calendar date 2026-09-15
    const day2 = new Date(Date.UTC(2026, 8, 16, 12, 0, 0)); // Karachi calendar date 2026-09-16

    const first = await reminderEngineService.runReminderEngine({ now: day1 });
    const second = await reminderEngineService.runReminderEngine({ now: day2 });

    expect(first.notificationsCreated).toBe(1);
    expect(second.notificationsCreated).toBe(1);
    expect(second.notificationsAlreadySent).toBe(0);

    const notifications = await Notification.find({ taskId: task._id, recipientUserId: user._id }).sort({
      createdAt: 1,
    });
    expect(notifications).toHaveLength(2);
    expect(notifications[0].dedupKey).toContain('2026-09-15');
    expect(notifications[1].dedupKey).toContain('2026-09-16');
    expect(notifications[0].dedupKey).not.toBe(notifications[1].dedupKey);
  });

  it('a duplicate is never surfaced as an application error — the run completes normally with no failures', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    await makeTask(admin, [user], 1);

    await reminderEngineService.runReminderEngine();
    const second = await reminderEngineService.runReminderEngine();

    expect(second.failures).toEqual([]);
  });
});

describe('reminder-engine.service — task-notification linkage (Phase 3 §15/§27)', () => {
  it('stores metadata.taskCodeNumber, matching what NotificationDrawer\'s existing click-handler already looks for', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user], 1);

    await reminderEngineService.runReminderEngine();

    const notification = await Notification.findOne({ taskId: task._id, recipientUserId: user._id });
    expect(notification.metadata.taskCodeNumber).toBe(task.codeNumber);
    expect(notification.source).toBe('system');
    expect(notification.createdBy).toBeNull();
  });
});

describe('reminder-engine.service — preserved task state maintenance (Phase 3 §8/§24 F)', () => {
  it('recomputes a stale timeStatus using the real computeTimeStatus, and saves the correction', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user], 10);
    await Task.findByIdAndUpdate(task.id, { 'timeStatus.days': 999, 'timeStatus.type': 'remaining' });

    await reminderEngineService.runReminderEngine();

    const corrected = await Task.findById(task.id);
    expect(corrected.timeStatus.days).toBe(taskService.computeTimeStatus(corrected).days);
    expect(corrected.timeStatus.days).not.toBe(999);
  });

  it('flips status from "ongoing" to "pending" the moment a task becomes overdue', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user], -1);
    expect((await Task.findById(task.id)).status).toBe('ongoing');

    await reminderEngineService.runReminderEngine();

    const after = await Task.findById(task.id);
    expect(after.status).toBe('pending');
    expect(after.timeStatus.type).toBe('overdue');
  });

  it('does not touch status for a task that is still remaining', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user], 10);

    await reminderEngineService.runReminderEngine();

    expect((await Task.findById(task.id)).status).toBe('ongoing');
  });

  it('only scans ongoing/pending tasks, ignoring complete/closed ones', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    await makeTask(admin, [user], -1); // ongoing, overdue -> counted
    const closedTask = await makeTask(admin, [user], -1);
    await taskService.closeTask({ id: admin.id }, closedTask.id);

    const summary = await reminderEngineService.runReminderEngine();

    expect(summary.tasksScanned).toBe(1);
  });
});

describe('reminder-engine.service — error isolation (Phase 3 §16/§24 G)', () => {
  it('one task failing unexpectedly does not stop other tasks in the same scan from being processed', async () => {
    const admin = await makeAdmin();
    const userA = await makeUser();
    const userB = await makeUser();
    const failingTask = await makeTask(admin, [userA], 1);
    const okTask = await makeTask(admin, [userB], 1);

    const realComputeTimeStatus = taskService.computeTimeStatus;
    const computeSpy = jest.spyOn(taskService, 'computeTimeStatus').mockImplementation((task, now) => {
      if (String(task._id) === failingTask.id) {
        throw new Error('Simulated unexpected failure computing time status');
      }
      return realComputeTimeStatus(task, now);
    });

    const summary = await reminderEngineService.runReminderEngine();
    computeSpy.mockRestore();

    expect(summary.tasksScanned).toBe(2);
    expect(summary.failures).toHaveLength(1);
    expect(String(summary.failures[0].taskId)).toBe(failingTask.id);
    expect(summary.failures[0].reason).toMatch(/Simulated unexpected failure/);

    const okNotification = await Notification.findOne({ taskId: okTask._id, recipientUserId: userB._id });
    expect(okNotification).not.toBeNull();
    expect(okNotification.type).toBe(NOTIFICATION_TYPES.TASK_DUE_TOMORROW);
  });

  it('one recipient failing does not stop other recipients on the same task from being processed', async () => {
    const admin = await makeAdmin();
    const userA = await makeUser();
    const userB = await makeUser();
    const task = await makeTask(admin, [userA, userB], 1);

    const originalCreateSystemNotification = notificationService.createSystemNotification;
    const createSpy = jest
      .spyOn(notificationService, 'createSystemNotification')
      .mockImplementation((payload) => {
        if (String(payload.recipientUserId) === userA.id) {
          return Promise.reject(new Error('Simulated failure notifying this recipient'));
        }
        return originalCreateSystemNotification(payload);
      });

    const summary = await reminderEngineService.runReminderEngine();
    createSpy.mockRestore();

    expect(summary.failures).toHaveLength(1);
    expect(String(summary.failures[0].recipientUserId)).toBe(userA.id);
    expect(summary.failures[0].type).toBe(NOTIFICATION_TYPES.TASK_DUE_TOMORROW);
    expect(summary.notificationsCreated).toBe(1);

    expect(await Notification.findOne({ taskId: task._id, recipientUserId: userB._id })).not.toBeNull();
    expect(await Notification.findOne({ taskId: task._id, recipientUserId: userA._id })).toBeNull();
  });

  it('one failing task does not stop other tasks even when both have eligible recipients (whole-scan resilience)', async () => {
    const admin = await makeAdmin();
    const userA = await makeUser();
    const userB = await makeUser();
    const userC = await makeUser();
    const taskA = await makeTask(admin, [userA], 1);
    const taskB = await makeTask(admin, [userB], 1);
    const taskC = await makeTask(admin, [userC], 1);

    const realComputeTimeStatus = taskService.computeTimeStatus;
    const computeSpy = jest.spyOn(taskService, 'computeTimeStatus').mockImplementation((task, now) => {
      if (String(task._id) === taskB.id) {
        throw new Error('Simulated DB failure');
      }
      return realComputeTimeStatus(task, now);
    });

    const summary = await reminderEngineService.runReminderEngine();
    computeSpy.mockRestore();

    expect(summary.tasksScanned).toBe(3);
    expect(summary.failures).toHaveLength(1);
    expect(await Notification.countDocuments({ taskId: taskA._id })).toBe(1);
    expect(await Notification.countDocuments({ taskId: taskC._id })).toBe(1);
  });
});

describe('reminder-engine.service — result summary (Phase 3 §17)', () => {
  it('returns tasksScanned, tasksEligible, notificationsCreated, notificationsAlreadySent, failures', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    await makeTask(admin, [user], 1); // eligible
    await makeTask(admin, [user], 20); // not eligible (outside window)

    const summary = await reminderEngineService.runReminderEngine();

    expect(summary).toMatchObject({
      tasksScanned: 2,
      tasksEligible: 1,
      notificationsCreated: 1,
      notificationsAlreadySent: 0,
      failures: [],
    });
  });
});
