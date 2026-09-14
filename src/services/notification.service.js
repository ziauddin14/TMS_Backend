const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const NotificationBatch = require('../models/NotificationBatch');
const User = require('../models/User');
const Task = require('../models/Task');
const AppError = require('../utils/AppError');
const { NOTIFICATION_TYPES } = require('../utils/notificationTypes');
const { resolveTemplate } = require('../utils/notificationTemplates');

const VALID_TYPES = new Set(Object.values(NOTIFICATION_TYPES));

function assertValidType(type) {
  if (!VALID_TYPES.has(type)) {
    throw new AppError(`Unknown notification type: ${type}`, 500, 'INVALID_NOTIFICATION_TYPE');
  }
}

// Locked blueprint §11 — the ONE notification-creation entry point. Phase 2's admin flows and
// Phase 3's automatic reminder engine (neither built yet) must call this, never write to the
// Notification model directly, and never invent a second creation path.
//
// Idempotent for dedupKey-bearing (source:'system') calls: a duplicate dedupKey collides against
// the model's unique sparse index (E11000) and is treated as "already created for this
// task+recipient+Pakistan-day," not an error — returns the existing row instead of throwing. This
// is an atomic, database-level guarantee, not a check-then-insert race (locked blueprint §5).
// Admin-sourced calls never pass a dedupKey, so this branch never applies to them.
async function createNotification({
  recipientUserId,
  type,
  title,
  message,
  taskId = null,
  createdBy = null,
  source,
  dedupKey,
  metadata = {},
}) {
  assertValidType(type);
  // Normalizes null/''/undefined all to `undefined` — the field must be genuinely ABSENT from
  // the inserted document (not stored as an explicit null) for the model's sparse unique index to
  // correctly skip it; see Notification.js's own comment on why `default: null` was wrong here.
  const resolvedDedupKey = dedupKey || undefined;
  try {
    return await Notification.create({
      recipientUserId,
      type,
      title,
      message,
      taskId,
      createdBy,
      source,
      dedupKey: resolvedDedupKey,
      metadata,
    });
  } catch (err) {
    if (err.code === 11000 && resolvedDedupKey) {
      return Notification.findOne({ dedupKey: resolvedDedupKey });
    }
    throw err;
  }
}

// Bulk fan-out helper for a future caller resolving multiple recipients in one action (Phase 2's
// broadcast/task-reminder flows, Phase 3's per-task assignee fan-out) — not used by anything in
// Phase 1 itself, but the shared engine must exist ready for them per the locked blueprint.
// Sequential (not Promise.all) so one recipient's dedup-skip/failure can never race another's
// write — matches this codebase's existing "sequential by design" convention in
// reminder.job.js's own recipient loop.
async function createNotifications(payloads) {
  const results = [];
  for (const payload of payloads) {
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential, see comment above
    const doc = await createNotification(payload);
    results.push(doc);
  }
  return results;
}

function assertValidObjectId(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError('Notification not found.', 404, 'NOTIFICATION_NOT_FOUND');
  }
}

// GET /notifications — always scoped to the requesting user; recipientUserId is never accepted
// from the client (enforced by the controller only ever passing req.user.id here).
async function listForUser(userId, { page, limit, unreadOnly }) {
  const filter = { recipientUserId: userId };
  if (unreadOnly) filter.isRead = false;

  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

// GET /notifications/unread-count — a dedicated, index-backed count, never derived from loading
// the full list (locked blueprint §Performance).
async function getUnreadCount(userId) {
  return Notification.countDocuments({ recipientUserId: userId, isRead: false });
}

// PATCH /notifications/:id/read — ownership re-verified here (query filters on BOTH _id and
// recipientUserId together, not a separate existence-then-ownership check), so a notification
// belonging to another user is indistinguishable from a nonexistent one: both throw the same 404,
// never leaking whether the id exists (locked blueprint §Security). Idempotent: an already-read
// notification is a no-op, not an error.
async function markRead(userId, notificationId) {
  assertValidObjectId(notificationId);
  const notification = await Notification.findOne({ _id: notificationId, recipientUserId: userId });
  if (!notification) {
    throw new AppError('Notification not found.', 404, 'NOTIFICATION_NOT_FOUND');
  }
  if (!notification.isRead) {
    notification.isRead = true;
    notification.readAt = new Date();
    await notification.save();
  }
  return notification;
}

// PATCH /notifications/read-all — bulk-scoped to the requesting user only.
async function markAllRead(userId) {
  const result = await Notification.updateMany(
    { recipientUserId: userId, isRead: false },
    { $set: { isRead: true, readAt: new Date() } }
  );
  return { updatedCount: result.modifiedCount };
}

// docs alignment: locked blueprint §Phase 2 §7 — "template only -> template; custom only ->
// custom; template + custom -> custom message overrides the template's message, while the
// template still provides the title/context; neither -> 400." An unknown (but non-empty)
// templateKey is always a hard validation error, never silently ignored in favor of falling
// through to defaultTitle — that would let a client typo a key and get a confusing generic title
// with no indication anything was wrong.
function resolveContent({ templateKey, message, defaultTitle }) {
  const template = templateKey ? resolveTemplate(templateKey) : null;
  if (templateKey && !template) {
    throw new AppError('منتخب کردہ ٹیمپلیٹ درست نہیں ہے۔', 400, 'INVALID_TEMPLATE');
  }

  const trimmedMessage = typeof message === 'string' ? message.trim() : '';
  if (!template && !trimmedMessage) {
    throw new AppError('پیغام یا ٹیمپلیٹ درکار ہے۔', 400, 'MESSAGE_REQUIRED');
  }

  return {
    title: template ? template.title : defaultTitle,
    message: trimmedMessage || template.message,
  };
}

// Locked blueprint §11/§Phase 2 — the single fan-out+audit path every admin flow (Flow A/B/C)
// funnels through. Recipients are ALWAYS resolved by the caller from real DB data before this is
// called — this function never trusts or accepts a client-supplied recipient list. One failed
// recipient never aborts the others (mirrors reminder.job.js's own established resilience
// pattern) — failures are recorded on the NotificationBatch audit row, not swallowed. The batch
// row is written even when every recipient failed, so the failure is still visible in history;
// only then is an error thrown back to the controller (locked blueprint §13).
async function sendToRecipients({
  createdBy,
  recipientMode,
  targetUserId = null,
  targetTaskId = null,
  templateKey,
  message,
  type,
  taskId = null,
  recipients,
  defaultTitle,
}) {
  if (recipients.length === 0) {
    throw new AppError('کوئی اہل وصول کنندہ موجود نہیں۔', 400, 'NO_ELIGIBLE_RECIPIENTS');
  }

  const { title, message: finalMessage } = resolveContent({ templateKey, message, defaultTitle });

  const failures = [];
  let createdCount = 0;
  for (const recipient of recipients) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential by design, matching
      // reminder.job.js's own recipient loop: keeps failure isolation simple to reason about.
      await createNotification({
        recipientUserId: recipient._id,
        type,
        title,
        message: finalMessage,
        taskId,
        createdBy,
        source: 'admin',
      });
      createdCount += 1;
    } catch (err) {
      failures.push({ recipientUserId: recipient._id, name: recipient.name, reason: err.message });
    }
  }

  const batch = await NotificationBatch.create({
    createdBy,
    recipientMode,
    targetUserId,
    targetTaskId,
    templateKey: templateKey || null,
    message: finalMessage,
    recipientsResolved: recipients.length,
    createdCount,
    failures,
  });

  if (createdCount === 0) {
    throw new AppError('اطلاع بھیجنے میں ناکامی ہوئی۔', 500, 'NOTIFICATION_CREATION_FAILED');
  }

  return { batchId: batch.id, recipientsResolved: recipients.length, createdCount, failures };
}

// Flow A — POST /admin/notifications, recipientType:'all'. "تمام ذمہ داران" means every active
// role:'user' account (docs/09-frontend-features.md's own useAssignableUsers scoping, reused
// server-side) — admins are always excluded, never sent to themselves as a side effect of being
// active users too.
async function sendBroadcastToAllUsers({ createdBy, templateKey, message }) {
  const recipients = await User.find({ role: 'user', isActive: true });
  return sendToRecipients({
    createdBy,
    recipientMode: 'all',
    templateKey,
    message,
    type: NOTIFICATION_TYPES.ADMIN_BROADCAST,
    recipients,
    defaultTitle: 'انتظامی پیغام',
  });
}

// Flow B — POST /admin/notifications, recipientType:'user'. Eligibility re-checked here, not
// trusted from the client even for an id it itself just picked from a UI list: must exist, be
// active, and be role:'user' (an admin id is rejected the same way an invalid one is — both are
// simply "not an eligible recipient," no special-cased error for "that's an admin"). Exactly one
// notification, taskId stays null — per the locked blueprint, this is NOT "one notification per
// task," and no relatedTaskIds metadata is added without a concrete UI need for it.
async function sendToSpecificUser({ createdBy, userId, templateKey, message }) {
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    throw new AppError('منتخب کردہ یوزر موجود نہیں یا اہل نہیں ہے۔', 400, 'INVALID_RECIPIENT');
  }
  const user = await User.findOne({ _id: userId, role: 'user', isActive: true });
  if (!user) {
    throw new AppError('منتخب کردہ یوزر موجود نہیں یا اہل نہیں ہے۔', 400, 'INVALID_RECIPIENT');
  }

  return sendToRecipients({
    createdBy,
    recipientMode: 'user',
    targetUserId: user._id,
    templateKey,
    message,
    type: NOTIFICATION_TYPES.USER_REMINDER,
    recipients: [user],
    defaultTitle: 'انتظامی پیغام',
  });
}

// Flow C — POST /admin/tasks/:taskId/reminder. Recipients are resolved EXCLUSIVELY from the
// task's own stored `assignees` — the client sends only templateKey/message, never recipient ids
// (locked blueprint §Security: prevents a tampered request notifying arbitrary users under a
// task's name). Inactive assignees are filtered out; if that leaves nobody, 400 — never silently
// sends to zero people. Deliberately NOT deduplicated (dedupKey never set) — a manual admin
// reminder is a deliberate action each time, not something to suppress as a "duplicate" the way
// Phase 3's automatic engine will need to.
//
// Audit fix — also filters out `role !== 'user'`, matching Flow A/B's own explicit role check.
// task.service.js's own assignee validation (validateAssignees) checks only isActive, not role —
// the assignee picker never offers an admin as an option, but nothing at that layer actually
// PREVENTS an admin id from ending up in `assignees` via a direct API call bypassing the picker.
// Since this service is the security boundary for notification recipients (not task.service.js,
// deliberately left unmodified per this fix's own scope), the role check belongs here so "admins
// never receive manual task reminders" holds regardless of what task.assignees actually contains.
async function sendTaskReminder({ createdBy, taskId, templateKey, message }) {
  if (!taskId || !mongoose.Types.ObjectId.isValid(taskId)) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }
  const task = await Task.findById(taskId).populate('assignees');
  if (!task) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }

  const recipients = (task.assignees || []).filter((assignee) => assignee.isActive && assignee.role === 'user');
  if (recipients.length === 0) {
    throw new AppError('اس کام کا کوئی فعال ذمہ دار موجود نہیں۔', 400, 'NO_ELIGIBLE_RECIPIENTS');
  }

  return sendToRecipients({
    createdBy,
    recipientMode: 'task',
    targetTaskId: task._id,
    templateKey,
    message,
    type: NOTIFICATION_TYPES.TASK_REMINDER,
    taskId: task._id,
    recipients,
    defaultTitle: 'کام کی یاددہانی',
  });
}

// GET /admin/notifications/history — paginates NotificationBatch DIRECTLY (locked blueprint §9):
// no aggregation over Notification, no client-side grouping. Populated the same way
// task.service.js's own listTasks populates references, for the controller's serializer to read
// straight off.
async function listAdminHistory({ page, limit }) {
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    NotificationBatch.find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('createdBy', 'name')
      .populate('targetUserId', 'name')
      .populate('targetTaskId', 'title codeNumber'),
    NotificationBatch.countDocuments({}),
  ]);

  return { items, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

module.exports = {
  createNotification,
  createNotifications,
  listForUser,
  getUnreadCount,
  markRead,
  markAllRead,
  sendBroadcastToAllUsers,
  sendToSpecificUser,
  sendTaskReminder,
  listAdminHistory,
};
