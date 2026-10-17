const mongoose = require('mongoose');
const Task = require('../models/Task');
const User = require('../models/User');
const Notification = require('../models/Notification');
const notificationService = require('./notification.service');
const AppError = require('../utils/AppError');
const { NOTIFICATION_TYPES } = require('../utils/notificationTypes');
const { formatDateShortKarachi } = require('../utils/formatDate');
const logger = require('../utils/logger');

// Task receipt: when a task is given to someone they get a notice saying who gave it to them, and
// they confirm it with "وصول کر لیا". Until they do, they are reminded — at most once per level.
// The data lives on the task itself (models/Task.js `receipts`); this file is the only place that
// creates or changes it.
//
// Who takes part: only tasks created through the app (POST /tasks) after this feature shipped.
// The controller opts in; task.service.js does nothing unless it is told to, so the import and
// synthetic-rating scripts (which write tasks directly) and every older task stay out of it.

// Hours after the assignment at which reminder 1 and reminder 2 fall due — one entry per level, in
// ascending order. Counted from receipt.assignedAt.
const ACK_REMINDER_HOURS = Object.freeze([24, 48]);

// Two runs of the reminder pass that overlap (the hourly job and the daily backstop, or a manual
// trigger) can never both send to the same receipt: a receipt reminded within this many minutes
// is left alone. Far shorter than the gap between the levels, so it never delays a due reminder.
const MIN_MINUTES_BETWEEN_RECEIPT_REMINDERS = 30;

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const OPEN_STATUSES = Object.freeze(['ongoing', 'pending']);
const RECEIPT_NOTIFICATION_TYPES = Object.freeze([
  NOTIFICATION_TYPES.TASK_ASSIGNED,
  NOTIFICATION_TYPES.TASK_RECEIPT_REMINDER,
]);

// The approved wording. Reminder titles go by level (index 0 = reminder 1); a level beyond the
// list reuses the last title.
const ASSIGNED_TITLE = 'نیا کام سونپا گیا';
const REMINDER_TITLES = Object.freeze(['یاد دہانی: کام وصول کریں', 'دوسری یاد دہانی: کام وصول کریں']);
const CLOSING_SENTENCE = 'براہِ کرم وصول کر لیں۔';

// "<code> — <title>، آخری تاریخ <dd-MM-yy>۔" — the deadline as a Pakistan calendar date.
function taskLine(task) {
  return `${task.codeNumber} — ${task.title}، آخری تاریخ ${formatDateShortKarachi(task.deadline)}۔`;
}

function assignmentMessage(assignerName, task) {
  return `${assignerName} نے آپ کو یہ کام سونپا ہے: ${taskLine(task)} ${CLOSING_SENTENCE}`;
}

function reminderTitle(level) {
  return REMINDER_TITLES[Math.min(level, REMINDER_TITLES.length) - 1];
}

function reminderMessage(task) {
  return `${taskLine(task)} ${CLOSING_SENTENCE}`;
}

function idOf(value) {
  if (!value) return null;
  return String(value._id || value);
}

// Who gets a receipt: an active role:'user' assignee who is not the person giving the task.
// Admins never do (the same rule as every automatic reminder), and nor does a creator who puts
// themselves on their own task.
function isEligible(user, assignerId) {
  return Boolean(user) && user.isActive && user.role === 'user' && String(user._id) !== String(assignerId);
}

function newReceipt(userId, assigner, now) {
  return {
    user: userId,
    assignedAt: now,
    assignedBy: assigner.id,
    acknowledgedAt: null,
    supersededAt: null,
    notificationId: null,
    remindersSent: [],
  };
}

async function loadUsers(ids) {
  const valid = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (valid.length === 0) return new Map();
  const users = await User.find({ _id: { $in: valid } }).select('isActive role');
  return new Map(users.map((user) => [user.id, user]));
}

// The receipts a task created through the app starts with — one per eligible assignee, in the
// order they were given. Always an array (possibly empty): its presence is what marks the task as
// taking part, so a task whose only assignee is an admin can still pick up a receipt on reassign.
async function buildReceiptsForNewTask(assigneeIds, assigner, now = new Date()) {
  const ids = [...new Set(assigneeIds.map(String))];
  const users = await loadUsers(ids);
  return ids.filter((id) => isEligible(users.get(id), assigner.id)).map((id) => newReceipt(id, assigner, now));
}

// The assignees of a task that takes part have changed (PATCH /tasks/:id — the edit form or
// "ذمہ دار تبدیل کریں"). Mutates `task` before its caller saves it:
//   - a person taken off the task: their receipt is marked superseded (kept, no longer counted);
//   - a person newly on the task: a fresh receipt — returned, so the caller can send the notice
//     once the task is saved. Only while the task is still open: a completed task asks nobody to
//     confirm anything;
//   - everyone else keeps their receipt as it is and is not notified again.
// A task from before this feature (no `receipts`) is left exactly as it was.
async function applyAssigneeChange(task, newAssigneeIds, assigner, now = new Date()) {
  if (!Array.isArray(task.receipts)) return [];

  const keep = new Set(newAssigneeIds.map(String));
  task.receipts.forEach((receipt) => {
    if (!receipt.supersededAt && !keep.has(idOf(receipt.user))) {
      receipt.supersededAt = now;
    }
  });

  if (!OPEN_STATUSES.includes(task.status)) return [];

  const current = new Set(task.receipts.filter((receipt) => !receipt.supersededAt).map((receipt) => idOf(receipt.user)));
  const candidates = [...keep].filter((id) => !current.has(id));
  const users = await loadUsers(candidates);
  const added = [];
  candidates.forEach((id) => {
    if (!isEligible(users.get(id), assigner.id)) return;
    task.receipts.push(newReceipt(id, assigner, now));
    added.push(task.receipts[task.receipts.length - 1]);
  });
  return added;
}

// One assignment notice (in-app + push, through the one notification-creation path) per new
// receipt. A failure is logged and never undoes or fails the task change that led to it. Not an
// admin "send" either: no NotificationBatch is written, so these notices stay out of the admin's
// manual notification history.
async function notifyNewReceipts(task, receipts, assigner) {
  let sent = 0;
  for (const receipt of receipts) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential, like every other fan-out here
      const notification = await notificationService.createNotification({
        recipientUserId: idOf(receipt.user),
        type: NOTIFICATION_TYPES.TASK_ASSIGNED,
        title: ASSIGNED_TITLE,
        message: assignmentMessage(assigner.name, task),
        taskId: task._id,
        createdBy: assigner.id,
        source: 'admin',
        metadata: { taskCodeNumber: task.codeNumber, receiptId: String(receipt._id) },
      });
      // eslint-disable-next-line no-await-in-loop
      await Task.updateOne(
        { _id: task._id, 'receipts._id': receipt._id },
        { $set: { 'receipts.$.notificationId': notification._id } },
        { timestamps: false }
      );
      sent += 1;
    } catch (err) {
      logger.error(`Task receipt: assignment notice for task ${task._id} to ${idOf(receipt.user)} failed:`, err.message || err);
    }
  }
  return sent;
}

// POST /tasks/:id/acknowledge — the signed-in person confirms THEIR OWN receipt; nobody can confirm
// for anybody else (there is no user parameter at all). Atomic: one conditional update sets the
// time only if the receipt is still unconfirmed and current and the task still open. Idempotent:
// confirming again changes nothing and is not an error. timestamps:false — the task's updatedAt
// must not move (it is the closed-task fallback date of computeTimeStatus). The person's own
// notices about this task are marked read at the same time.
async function acknowledge(requestingUser, taskId, now = new Date()) {
  if (!mongoose.Types.ObjectId.isValid(taskId)) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }
  const userId = new mongoose.Types.ObjectId(requestingUser.id);

  const result = await Task.updateOne(
    {
      _id: taskId,
      status: { $in: OPEN_STATUSES },
      receipts: { $elemMatch: { user: userId, supersededAt: null, acknowledgedAt: null } },
    },
    { $set: { 'receipts.$.acknowledgedAt': now } },
    { timestamps: false }
  );

  if (result.modifiedCount !== 1) {
    const task = await Task.findById(taskId).select('assignees status receipts').lean();
    if (!task) {
      throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
    }
    const isAssignee = (task.assignees || []).some((id) => String(id) === requestingUser.id);
    if (!isAssignee) {
      throw new AppError('You are not assigned to this task.', 403, 'FORBIDDEN_NOT_ASSIGNEE');
    }
    const mine = (task.receipts || []).find((receipt) => idOf(receipt.user) === requestingUser.id && !receipt.supersededAt);
    if (!mine) {
      throw new AppError('There is nothing on this task for you to confirm.', 409, 'NO_RECEIPT');
    }
    if (!mine.acknowledgedAt) {
      throw new AppError('This task is no longer open.', 409, 'TASK_NOT_OPEN');
    }
    // Already confirmed: nothing to do.
  }

  await Notification.updateMany(
    { recipientUserId: userId, taskId, type: { $in: RECEIPT_NOTIFICATION_TYPES }, isRead: false },
    { $set: { isRead: true, readAt: now } }
  );
  // true when THIS call confirmed the receipt; false when it had been confirmed already.
  return result.modifiedCount === 1;
}

// The reminder level due for one receipt now: the lowest level not yet sent, if its threshold has
// passed — otherwise none (the thresholds ascend, so no higher level can be due either).
function dueLevel(receipt, now) {
  const sent = new Set((receipt.remindersSent || []).map((entry) => entry.level));
  const elapsed = now.getTime() - new Date(receipt.assignedAt).getTime();
  for (let index = 0; index < ACK_REMINDER_HOURS.length; index += 1) {
    const level = index + 1;
    if (!sent.has(level)) {
      return elapsed >= ACK_REMINDER_HOURS[index] * HOUR_MS ? level : null;
    }
  }
  return null;
}

// Send reminder `level` for one receipt. First the level is CLAIMED with one atomic update — it
// only succeeds while the receipt is still unconfirmed and current, the task still open, this
// level not yet sent, and no reminder sent to this receipt in the last MIN_MINUTES_BETWEEN_...
// minutes. Only the run whose claim succeeded sends; the notification's dedupKey
// (ACK_REMINDER:{task}:{receipt}:{level}, on the existing unique index) is a second guarantee.
// If the notice cannot be created the claim is given back, so a later run tries again.
async function sendReminder(task, receipt, level, now) {
  const cutoff = new Date(now.getTime() - MIN_MINUTES_BETWEEN_RECEIPT_REMINDERS * MINUTE_MS);
  const claim = await Task.updateOne(
    {
      _id: task._id,
      status: { $in: OPEN_STATUSES },
      receipts: {
        $elemMatch: {
          _id: receipt._id,
          supersededAt: null,
          acknowledgedAt: null,
          'remindersSent.level': { $ne: level },
          'remindersSent.sentAt': { $not: { $gt: cutoff } },
        },
      },
    },
    { $push: { 'receipts.$.remindersSent': { level, sentAt: now } } },
    { timestamps: false }
  );
  if (claim.modifiedCount !== 1) return false;

  try {
    const { created } = await notificationService.createSystemNotification({
      recipientUserId: idOf(receipt.user),
      type: NOTIFICATION_TYPES.TASK_RECEIPT_REMINDER,
      title: reminderTitle(level),
      message: reminderMessage(task),
      taskId: task._id,
      dedupKey: `ACK_REMINDER:${task._id}:${receipt._id}:${level}`,
      metadata: { taskCodeNumber: task.codeNumber, receiptId: String(receipt._id), level },
    });
    return created;
  } catch (err) {
    await Task.updateOne(
      { _id: task._id, 'receipts._id': receipt._id },
      { $pull: { 'receipts.$.remindersSent': { level, sentAt: now } } },
      { timestamps: false }
    );
    throw err;
  }
}

// The receipt reminder pass — called by POST /admin/trigger-receipt-reminders (hourly) and, as a
// backstop, by the daily POST /admin/trigger-reminders. At most ONE reminder per receipt per run:
// the lowest level not yet sent whose threshold has passed (so after a missed run the two levels
// still arrive at least one run apart). Nothing is sent once the receipt is confirmed or
// superseded, once the task is closed or complete, or to an inactive or non-user account; and
// never more than ACK_REMINDER_HOURS.length reminders. `now` is injectable for tests only.
async function runReceiptReminders({ now = new Date() } = {}) {
  const firstDue = new Date(now.getTime() - ACK_REMINDER_HOURS[0] * HOUR_MS);
  const tasks = await Task.find({
    status: { $in: OPEN_STATUSES },
    receipts: { $elemMatch: { supersededAt: null, acknowledgedAt: null, assignedAt: { $lte: firstDue } } },
  }).populate('receipts.user', 'isActive role');

  let remindersSent = 0;
  const failures = [];
  for (const task of tasks) {
    for (const receipt of task.receipts) {
      const user = receipt.user;
      const level = !receipt.supersededAt && !receipt.acknowledgedAt ? dueLevel(receipt, now) : null;
      if (level && user && user.isActive && user.role === 'user') {
        try {
          // eslint-disable-next-line no-await-in-loop -- sequential by design, like the daily engine
          if (await sendReminder(task, receipt, level, now)) remindersSent += 1;
        } catch (err) {
          logger.error(`Task receipt: reminder ${level} for task ${task._id} to ${idOf(user)} failed:`, err.message || err);
          failures.push({ taskId: task._id, receiptId: receipt._id, level, reason: err.message });
        }
      }
    }
  }

  logger.info(`Receipt reminders: ${tasks.length} tasks scanned, ${remindersSent} sent, ${failures.length} failures`);
  return { tasksScanned: tasks.length, remindersSent, failures };
}

// GET /notifications — the current state of the signed-in person's receipt for each assignment
// notice / receipt reminder in the list, so the bell can show "وصول کر لیا" or "✓ وصول شدہ" as it
// is now (they may have confirmed elsewhere). Returns Map(notificationId -> state); other
// notifications are not in it.
async function receiptStatesForNotifications(userId, notifications) {
  const relevant = notifications.filter((n) => RECEIPT_NOTIFICATION_TYPES.includes(n.type) && n.taskId);
  const states = new Map();
  if (relevant.length === 0) return states;

  const taskIds = [...new Set(relevant.map((n) => String(n.taskId)))];
  const tasks = await Task.find({ _id: { $in: taskIds } }).select('status receipts').lean();
  const byId = new Map(tasks.map((task) => [String(task._id), task]));

  relevant.forEach((notification) => {
    const task = byId.get(String(notification.taskId));
    const mine = (task?.receipts || []).find((receipt) => idOf(receipt.user) === String(userId) && !receipt.supersededAt);
    states.set(notification.id, {
      acknowledgedAt: mine?.acknowledgedAt || null,
      canAcknowledge: Boolean(mine && !mine.acknowledgedAt && OPEN_STATUSES.includes(task.status)),
    });
  });
  return states;
}

module.exports = {
  ACK_REMINDER_HOURS,
  MIN_MINUTES_BETWEEN_RECEIPT_REMINDERS,
  RECEIPT_NOTIFICATION_TYPES,
  buildReceiptsForNewTask,
  applyAssigneeChange,
  notifyNewReceipts,
  acknowledge,
  runReceiptReminders,
  receiptStatesForNotifications,
  // exported for tests
  dueLevel,
  assignmentMessage,
  reminderMessage,
  reminderTitle,
};
