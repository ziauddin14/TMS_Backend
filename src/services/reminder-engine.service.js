const Task = require('../models/Task');
const taskService = require('./task.service');
const notificationService = require('./notification.service');
const { NOTIFICATION_TYPES } = require('../utils/notificationTypes');
const env = require('../config/env');
const logger = require('../utils/logger');

// Locked blueprint §Phase 3/§10 — automatic reminder content, one place per type (never
// duplicated string literals across this file). Deliberately separate from
// utils/notificationTemplates.js: that registry is the ADMIN template picker's own vocabulary
// (a human chooses a templateKey), while these three types are assigned by the engine itself from
// a task's computed time status — a different concept with its own fixed, non-choosable wording.
const AUTOMATIC_REMINDER_CONTENT = Object.freeze({
  [NOTIFICATION_TYPES.TASK_OVERDUE]: {
    title: 'کام کی آخری تاریخ گزر چکی ہے',
    message: 'کام کی آخری تاریخ گزر چکی ہے۔ براہِ کرم فوری توجہ دیں۔',
  },
  [NOTIFICATION_TYPES.TASK_DUE_TOMORROW]: {
    title: 'کام کی آخری تاریخ کل ہے',
    message: 'اس کام کی آخری تاریخ کل ہے۔',
  },
  [NOTIFICATION_TYPES.TASK_DUE_TODAY]: {
    title: 'کام کی آخری تاریخ آج ہے',
    message: 'اس کام کی آخری تاریخ آج ہے۔ براہِ کرم آج ہی تازہ ترین اپڈیٹ فراہم کریں۔',
  },
  [NOTIFICATION_TYPES.TASK_DUE_SOON]: {
    title: 'کام کی آخری تاریخ قریب ہے',
    message: 'اس کام کی آخری تاریخ قریب ہے۔',
  },
});

// Precedence: OVERDUE > DUE_TODAY > DUE_TOMORROW > DUE_SOON > nothing. Each branch is keyed off a
// mutually exclusive `days` value (0, 1, or >1), so there is no actual overlap to arbitrate — the
// ordering below just reads chronologically.
//
// Production incident fix (task 260906, 2026-09-25): the original three-branch version had no
// case for `{ type: 'remaining', days: 0 }` (deadline is Karachi-today, not yet overdue) — it fell
// straight to `return null`, so a due-today task was silently skipped by every scan, forever
// (the next classification it could ever receive was OVERDUE, one calendar day later). This was a
// genuine gap, not a deliberate exclusion, despite an earlier comment here claiming otherwise —
// the Dashboard itself already treats days:0 as a distinct, meaningful state (its own "آج آخری
// تاریخ ہے" label, frontend/src/utils/formatDate.js), so the reminder engine now does too.
function classify(timeStatus) {
  if (timeStatus.type === 'overdue') {
    return NOTIFICATION_TYPES.TASK_OVERDUE;
  }
  if (timeStatus.type === 'remaining') {
    if (timeStatus.days === 0) {
      return NOTIFICATION_TYPES.TASK_DUE_TODAY;
    }
    if (timeStatus.days === 1) {
      return NOTIFICATION_TYPES.TASK_DUE_TOMORROW;
    }
    if (timeStatus.days > 1 && timeStatus.days <= env.REMINDER_DAYS_BEFORE) {
      return NOTIFICATION_TYPES.TASK_DUE_SOON;
    }
  }
  return null;
}

// Recipient rule (locked blueprint §9) — ACTIVE role:'user' assignees only, resolved here from
// real, currently-populated User records (never trusted from any other layer). Mirrors
// notification.service.js's own Flow C re-check (task.service.js's validateAssignees checks only
// isActive, not role, so an admin id can legitimately be present in task.assignees) — each flow
// independently re-verifies eligibility at the point it actually sends, this one included.
function resolveRecipients(task) {
  return (task.assignees || []).filter((assignee) => assignee.isActive && assignee.role === 'user');
}

// AUTO_REMINDER:{taskId}:{recipientUserId}:{PakistanDate} — deliberately excludes `type` (locked
// blueprint §11): a task reclassified from DUE_SOON to OVERDUE later the same Pakistan day must
// still collide on the same key, so the first successfully inserted classification wins and no
// second automatic notification is ever created for the same task+recipient+day.
function buildDedupKey(taskId, recipientUserId, pakistanDate) {
  return `AUTO_REMINDER:${taskId}:${recipientUserId}:${pakistanDate}`;
}

// One recipient, one atomic create-or-detect-duplicate call through the shared notification
// service (never Notification.create() directly, never a findOne-then-create race — the unique
// sparse dedupKey index is the sole concurrency authority, per locked blueprint §12).
// metadata.taskCodeNumber is what NotificationDrawer's existing (Phase 1) click-handler already
// looks for to navigate to the task — no frontend change is needed to "identify the task."
async function notifyRecipient({ task, recipient, type, pakistanDate }) {
  const content = AUTOMATIC_REMINDER_CONTENT[type];
  const { created } = await notificationService.createSystemNotification({
    recipientUserId: recipient._id,
    type,
    title: content.title,
    message: content.message,
    taskId: task._id,
    dedupKey: buildDedupKey(task._id, recipient._id, pakistanDate),
    metadata: { taskCodeNumber: task.codeNumber },
  });
  return created;
}

// A. task status/time-status maintenance — preserved from the pre-Phase-3 reminder.job.js's own
// processTask (locked blueprint §8): recompute timeStatus via the one shared computeTimeStatus,
// and flip ongoing -> pending the moment a task becomes overdue. Kept here, separate from B below,
// so both stay correct independently of whether any notification ends up being sent.
async function maintainTaskState(task, now) {
  const newTimeStatus = taskService.computeTimeStatus(task, now);
  const timeStatusChanged =
    task.timeStatus?.type !== newTimeStatus.type || task.timeStatus?.days !== newTimeStatus.days;

  task.timeStatus = newTimeStatus;

  let statusChanged = false;
  if (newTimeStatus.type === 'overdue' && task.status === 'ongoing') {
    task.status = 'pending';
    statusChanged = true;
  }

  if (timeStatusChanged || statusChanged) {
    await task.save();
  }

  return newTimeStatus;
}

// B. notification creation — classify, resolve recipients, notify each independently. One
// recipient's unexpected failure never aborts the others on the same task (locked blueprint §16);
// an expected E11000 duplicate is not a failure at all, just notificationsAlreadySent.
async function processTask(task, { now, pakistanDate }) {
  const timeStatus = await maintainTaskState(task, now);

  const type = classify(timeStatus);
  if (!type) {
    return { eligible: false, notificationsCreated: 0, notificationsAlreadySent: 0, failures: [] };
  }

  const recipients = resolveRecipients(task);
  let notificationsCreated = 0;
  let notificationsAlreadySent = 0;
  const failures = [];

  for (const recipient of recipients) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential by design, matching this
      // codebase's established reminder-scan convention (reminder.job.js, notification.service.js's
      // sendToRecipients) — keeps per-recipient failure isolation simple to reason about at this
      // project's confirmed small scale (no queue/worker infrastructure needed or wanted).
      const created = await notifyRecipient({ task, recipient, type, pakistanDate });
      if (created) {
        notificationsCreated += 1;
      } else {
        notificationsAlreadySent += 1;
      }
    } catch (err) {
      logger.error(
        `Reminder engine: failed to notify recipient ${recipient._id} for task ${task._id} (${type}):`,
        err
      );
      failures.push({ taskId: task._id, recipientUserId: recipient._id, type, reason: err.message });
    }
  }

  return { eligible: true, notificationsCreated, notificationsAlreadySent, failures };
}

// The single entry point (locked blueprint architecture: Scheduler -> reminder-engine.service.js
// -> notification.service.js -> Notification collection -> existing Bell/Drawer). Called
// identically by the admin manual trigger (admin.controller.js) and, in production, by whatever
// invokes scripts/run-reminder-engine.js on a schedule — never a second, parallel implementation.
// `now` is injectable only for deterministic tests; every real caller uses the default.
async function runReminderEngine({ now = new Date() } = {}) {
  const tasks = await Task.find({ status: { $in: ['ongoing', 'pending'] } }).populate(
    'assignees',
    'name isActive role'
  );
  const pakistanDate = taskService.getPakistanDateString(now);

  let tasksEligible = 0;
  let notificationsCreated = 0;
  let notificationsAlreadySent = 0;
  const failures = [];

  for (const task of tasks) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential by design, see processTask above.
      const result = await processTask(task, { now, pakistanDate });
      if (result.eligible) tasksEligible += 1;
      notificationsCreated += result.notificationsCreated;
      notificationsAlreadySent += result.notificationsAlreadySent;
      failures.push(...result.failures);
    } catch (err) {
      // Unexpected failure scanning/saving the task itself (not a per-recipient notification
      // failure, which processTask already isolates) — logged with context, never allowed to
      // abort the rest of the scan (locked blueprint §16).
      logger.error(`Reminder engine: unexpected failure processing task ${task._id}:`, err);
      failures.push({ taskId: task._id, recipientUserId: null, type: null, reason: err.message });
    }
  }

  const summary = { tasksScanned: tasks.length, tasksEligible, notificationsCreated, notificationsAlreadySent, failures };
  logger.info(
    `Reminder engine: ${summary.tasksScanned} tasks scanned, ${summary.tasksEligible} eligible, ` +
      `${summary.notificationsCreated} created, ${summary.notificationsAlreadySent} already sent, ` +
      `${summary.failures.length} failures`
  );
  return summary;
}

module.exports = { runReminderEngine };
