const reminderEngineService = require('../services/reminder-engine.service');
const notificationService = require('../services/notification.service');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

// POST /admin/trigger-reminders — docs/05-apis.md §10. Phase 3: now runs the automatic reminder
// engine (Scheduler -> reminder-engine.service.js -> notification.service.js -> Notification
// collection -> existing Bell/Drawer) instead of the old email-only reminder.job.js path — the
// exact same engine a production scheduler invokes, not a parallel/duplicate implementation. The
// route/response CONTRACT is preserved (`{ remindersSent }`) so the existing frontend trigger
// button and its own regression test keep working unmodified; `remindersSent` now means "genuinely
// new automatic notifications created this run" (duplicates the dedup guarantee already caught are
// correctly excluded — they were not, in fact, (re)sent). This stays "manually run today's
// automatic reminder check now," a distinct action from the Phase 2 manual composer below.
const triggerReminders = asyncHandler(async (req, res) => {
  const { notificationsCreated } = await reminderEngineService.runReminderEngine();
  sendSuccess(res, { data: { remindersSent: notificationsCreated } });
});

// Explicit whitelist, matching notification.controller.js's own serializeNotification pattern —
// never trusts the model's raw toJSON() shape verbatim.
function serializeBatch(batch) {
  return {
    batchId: batch.id,
    createdAt: batch.createdAt,
    createdBy: batch.createdBy ? { id: batch.createdBy.id, name: batch.createdBy.name } : null,
    recipientMode: batch.recipientMode,
    targetUser: batch.targetUserId ? { id: batch.targetUserId.id, name: batch.targetUserId.name } : null,
    targetTask: batch.targetTaskId
      ? { id: batch.targetTaskId.id, title: batch.targetTaskId.title, codeNumber: batch.targetTaskId.codeNumber }
      : null,
    templateKey: batch.templateKey,
    message: batch.message,
    recipientsResolved: batch.recipientsResolved,
    createdCount: batch.createdCount,
    failures: batch.failures,
  };
}

// POST /admin/notifications — Flow A ('all') and Flow B ('user'), locked blueprint §4/§5. Recipient
// resolution happens entirely inside notification.service.js — this controller never builds or
// passes a recipient list itself.
const sendAdminNotification = asyncHandler(async (req, res) => {
  const { recipientType, userId, templateKey, message } = req.body;
  const result =
    recipientType === 'all'
      ? await notificationService.sendBroadcastToAllUsers({ createdBy: req.user.id, templateKey, message })
      : await notificationService.sendToSpecificUser({ createdBy: req.user.id, userId, templateKey, message });
  sendSuccess(res, { data: result, statusCode: 201 });
});

// POST /admin/tasks/:taskId/reminder — Flow C, locked blueprint §6. taskId comes from the URL
// (real task data), never from the request body.
const sendTaskReminder = asyncHandler(async (req, res) => {
  const { templateKey, message } = req.body;
  const result = await notificationService.sendTaskReminder({
    createdBy: req.user.id,
    taskId: req.params.taskId,
    templateKey,
    message,
  });
  sendSuccess(res, { data: result, statusCode: 201 });
});

// GET /admin/notifications/history — locked blueprint §9/§11: paginates NotificationBatch
// directly, no aggregation, no client-side grouping.
const getNotificationHistory = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const { items, meta } = await notificationService.listAdminHistory({ page, limit });
  sendSuccess(res, { data: items.map(serializeBatch), meta });
});

module.exports = { triggerReminders, sendAdminNotification, sendTaskReminder, getNotificationHistory };
