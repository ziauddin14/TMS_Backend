const mongoose = require('mongoose');
const applyToJSON = require('./plugins/applyToJSON');

const { Schema } = mongoose;

// Locked blueprint §2 — the single user-facing notification store. Every future caller (Phase 2's
// admin flows, Phase 3's automatic reminder engine) writes here through notification.service.js's
// createNotification/createNotifications — never directly against this model.
//
// `type` is deliberately a bare String, NOT a Mongoose enum — a hard schema enum would force a
// code migration every time a new notification type is introduced (Phase 4/5's TASK_ASSIGNED,
// TASK_UPDATED, etc., explicitly not built yet). The known-value set is validated instead at the
// service layer, against utils/notificationTypes.js's NOTIFICATION_TYPES registry.
//
// `dedupKey` is populated ONLY on source:'system' rows (Phase 3's automatic reminder engine),
// format `AUTO_REMINDER:{taskId}:{recipientUserId}:{PakistanDate}` — deliberately excludes `type`
// so a task's classification changing between two same-day scans still collides on the same key
// (locked blueprint §5). Deliberately NO `default` here (not even `default: null`) — a sparse
// index only excludes documents where the field is genuinely ABSENT, not documents that explicitly
// store `null` (MongoDB indexes an explicit null as a real, collidable value). Admin-sourced rows
// must never pass dedupKey to notification.service.js's createNotification() at all, so the field
// is left entirely unset on those documents and the sparse index correctly ignores them — letting
// admins send the same person multiple messages the same day without ever tripping a false
// "duplicate."
const notificationSchema = new Schema(
  {
    recipientUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    source: { type: String, enum: ['admin', 'system'], required: true },
    isRead: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
    dedupKey: { type: String },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// Primary read pattern: "my notifications, unread-first-or-filtered, newest first."
notificationSchema.index({ recipientUserId: 1, isRead: 1, createdAt: -1 });
// General paginated list (unreadOnly not applied).
notificationSchema.index({ recipientUserId: 1, createdAt: -1 });
// Idempotency guarantee for the automatic reminder engine (Phase 3) — see the schema comment
// above. Sparse: admin-sourced rows (dedupKey: null) are excluded from the index entirely.
notificationSchema.index({ dedupKey: 1 }, { unique: true, sparse: true });
// Optional task-scoped lookups (admin history drill-down in Phase 2, not used by Phase 1).
notificationSchema.index({ taskId: 1 });

applyToJSON(notificationSchema);

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
