const notificationService = require('../services/notification.service');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

// Explicit whitelist (matches task.controller.js's own serializeTask pattern) rather than
// trusting the model's raw toJSON() output verbatim — keeps what the API exposes deliberate even
// as the schema grows in later phases.
function serializeNotification(notification) {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    taskId: notification.taskId,
    createdBy: notification.createdBy,
    source: notification.source,
    isRead: notification.isRead,
    readAt: notification.readAt,
    metadata: notification.metadata,
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt,
  };
}

// GET /notifications — always scoped to req.user.id, never a client-supplied recipient.
const listNotifications = asyncHandler(async (req, res) => {
  const { page, limit, unreadOnly } = req.query;
  const { items, meta } = await notificationService.listForUser(req.user.id, { page, limit, unreadOnly });
  sendSuccess(res, { data: items.map(serializeNotification), meta });
});

// GET /notifications/unread-count
const getUnreadCount = asyncHandler(async (req, res) => {
  const count = await notificationService.getUnreadCount(req.user.id);
  sendSuccess(res, { data: { count } });
});

// PATCH /notifications/:id/read — ownership enforced inside the service (404 on mismatch, not 403
// — never confirms another user's notification exists).
const markRead = asyncHandler(async (req, res) => {
  const notification = await notificationService.markRead(req.user.id, req.params.id);
  sendSuccess(res, { data: serializeNotification(notification) });
});

// PATCH /notifications/read-all
const markAllRead = asyncHandler(async (req, res) => {
  const { updatedCount } = await notificationService.markAllRead(req.user.id);
  sendSuccess(res, { data: { updatedCount } });
});

module.exports = { listNotifications, getUnreadCount, markRead, markAllRead };
