const mongoose = require('mongoose');
const applyToJSON = require('./plugins/applyToJSON');

const { Schema } = mongoose;

// Locked blueprint §2 — an audit-only summary of ONE admin send action (Flow A/B/C), NOT a second
// notification store: the actual user-facing rows still live exclusively in the Notification
// collection, written exclusively through notification.service.js's createNotification/
// createNotifications. This collection exists purely so admin history can be listed accurately and
// paginated directly (no aggregation over Notification, no client-side grouping) — see
// notification.service.js's sendToRecipients, the one place that writes both.
const failureSchema = new Schema(
  {
    recipientUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    name: { type: String },
    reason: { type: String },
  },
  { _id: false }
);

const notificationBatchSchema = new Schema(
  {
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    recipientMode: { type: String, enum: ['all', 'user', 'task'], required: true },
    targetUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    targetTaskId: { type: Schema.Types.ObjectId, ref: 'Task', default: null },
    templateKey: { type: String, default: null },
    message: { type: String, required: true },
    recipientsResolved: { type: Number, required: true },
    createdCount: { type: Number, required: true },
    failures: { type: [failureSchema], default: [] },
  },
  { timestamps: true }
);

// Plain admin history listing, newest first — no other query shape is needed (history is never
// filtered/searched in Phase 2, matching "operational history panel, not analytics dashboard").
notificationBatchSchema.index({ createdAt: -1 });
notificationBatchSchema.index({ createdBy: 1, createdAt: -1 });

applyToJSON(notificationBatchSchema);

module.exports = mongoose.models.NotificationBatch || mongoose.model('NotificationBatch', notificationBatchSchema);
