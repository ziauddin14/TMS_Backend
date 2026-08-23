const cron = require('node-cron');
const Task = require('../models/Task');
const User = require('../models/User');
const NotificationLog = require('../models/NotificationLog');
const taskService = require('../services/task.service');
const emailService = require('../services/email.service');
const env = require('../config/env');
const logger = require('../utils/logger');

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// docs/06-backend.md §8 steps 3-4: "check NotificationLog for an existing entry for this task
// TODAY" — per-calendar-day dedup. docs/04-db-models.md §7's own comment says "in the last N
// days," which reads differently; §8's literal steps are the authoritative algorithm here (the
// Phase 9 instructions call this out explicitly) — implemented as "today" only.
async function hasBeenNotifiedToday(taskId, type) {
  const existing = await NotificationLog.findOne({ taskId, type, sentAt: { $gte: startOfToday() } });
  return Boolean(existing);
}

// "send to every assignee + Admin" (docs/06-backend.md §8 step 3) — the system supports more
// than one Admin (docs/04-db-models.md §2's role enum, no "the one Admin" concept anywhere), so
// this means every active admin, not a single distinguished user. De-duplicated by email in case
// an Admin happens to also be an assignee on their own task.
async function collectRecipients(task) {
  const [assignees, admins] = await Promise.all([
    User.find({ _id: { $in: task.assignees }, isActive: true }),
    User.find({ role: 'admin', isActive: true }),
  ]);
  const byEmail = new Map();
  [...assignees, ...admins].forEach((u) => byEmail.set(u.email, u));
  return [...byEmail.values()];
}

// NotificationLog has no recipient field (docs/04-db-models.md §7's schema, Phase 2, left
// unmodified) — so dedup is necessarily per (taskId, type) per day, not per recipient. One entry
// represents "the reminder round for this task+type went out today," regardless of how many
// people were on it. Only logged once at least one recipient actually received it (see the
// send loop below) — logging on total failure would silently swallow a whole day's reminder for
// that task if SMTP were down; leaving it unlogged lets the next run (cron or manual) retry.
async function sendAndLog(task, type, sendFn) {
  const recipients = await collectRecipients(task);
  let anySent = false;
  for (const recipient of recipients) {
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: keeps SMTP load
    // predictable at this project's confirmed scale (~25 users) and keeps failure isolation
    // simple to reason about (one recipient's rejection can't race the log-write below).
    const ok = await sendFn(task, recipient);
    if (ok) anySent = true;
  }
  if (anySent) {
    await NotificationLog.create({ taskId: task._id, type });
  }
  return anySent;
}

/**
 * docs/06-backend.md §8, per task. Recomputes timeStatus via task.service.js's computeTimeStatus
 * (Phase 5, called directly — not reimplemented). Also implements the "flips ongoing -> pending"
 * status transition described in docs/02-db-design.md §8 and restated in §8 step 2 here: neither
 * doc actually shows this as part of computeTimeStatus's own logic (docs/06-backend.md §4.4's
 * pure-function pseudocode only ever touches timeStatus, never status), so it cannot be "reused"
 * from that function — it's implemented here instead, as the one small piece of job-owned logic,
 * leaving task.service.js completely unmodified. See the Phase 9 report, section C, for the full
 * reasoning.
 */
async function processTask(task) {
  const newTimeStatus = taskService.computeTimeStatus(task);
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

  let reminderSent = false;

  if (newTimeStatus.type === 'remaining' && newTimeStatus.days <= env.REMINDER_DAYS_BEFORE) {
    if (!(await hasBeenNotifiedToday(task._id, 'deadline_soon'))) {
      reminderSent = await sendAndLog(task, 'deadline_soon', emailService.sendDeadlineSoonEmail);
    }
  } else if (newTimeStatus.type === 'overdue') {
    if (!(await hasBeenNotifiedToday(task._id, 'overdue'))) {
      reminderSent = await sendAndLog(task, 'overdue', emailService.sendOverdueEmail);
    }
  }

  return reminderSent;
}

// docs/06-backend.md §8 — the core reusable function, called identically by the cron schedule
// below and by POST /admin/trigger-reminders (docs/05-apis.md §10) — never a separate copy.
async function runReminderScan() {
  const tasks = await Task.find({ status: { $in: ['ongoing', 'pending'] } });

  let remindersSent = 0;
  for (const task of tasks) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design: one task's DB/email
    // work must fully settle (including its own NotificationLog write) before the next task
    // starts, so a mid-batch failure can never leave two tasks' writes interleaved/ambiguous.
    const sent = await processTask(task);
    if (sent) remindersSent += 1;
  }

  logger.info(`Reminder scan: ${tasks.length} tasks scanned, ${remindersSent} reminders sent`);
  return { tasksScanned: tasks.length, remindersSent };
}

// docs/06-backend.md §8: node-cron, timezone 'Asia/Karachi', once daily early morning. Exported
// as its own function (not run at module load) and only ever called from server.js — the same
// "tests only ever import app.js, never server.js" pattern already used for connectDB() — so the
// schedule is never registered during the test suite, with no extra NODE_ENV guard needed here.
function startReminderCron() {
  cron.schedule(
    '0 7 * * *',
    () => {
      runReminderScan().catch((err) => logger.error('Reminder scan failed:', err));
    },
    { timezone: 'Asia/Karachi' }
  );
  logger.info('Reminder cron scheduled: 0 7 * * * (Asia/Karachi)');
}

module.exports = { runReminderScan, startReminderCron };
