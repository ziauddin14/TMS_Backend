const mongoose = require('mongoose');
const applyToJSON = require('./plugins/applyToJSON');

const { Schema } = mongoose;

// docs/04-db-models.md §7 — schema is authoritative, transcribed as documented.
// NOTE: no unique index is documented here. Deduplication ("did I already send a deadline_soon
// notice for this task today?") is explicit service-layer logic in the reminder job (a later
// phase), which queries this index before inserting — not a DB-level uniqueness constraint. See
// the Phase 2 report, section H, for why this is called out rather than silently added.
const notificationLogSchema = new Schema(
  {
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    type: { type: String, enum: ['deadline_soon', 'overdue'], required: true },
    channel: { type: String, enum: ['email'], default: 'email' },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

notificationLogSchema.index({ taskId: 1, type: 1, sentAt: -1 });

applyToJSON(notificationLogSchema);

module.exports = mongoose.models.NotificationLog || mongoose.model('NotificationLog', notificationLogSchema);
