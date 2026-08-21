const mongoose = require('mongoose');
const applyToJSON = require('./plugins/applyToJSON');

const { Schema } = mongoose;

// docs/04-db-models.md §4 — schema is authoritative, transcribed as documented.
const attachmentSchema = new Schema(
  {
    driveFileId: { type: String },
    fileName: { type: String },
    url: { type: String },
  },
  { _id: false }
);

const taskUpdateSchema = new Schema(
  {
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    description: { type: String, required: true, trim: true },
    completionPercent: { type: Number, min: 0, max: 100, required: true },
    attachment: { type: attachmentSchema, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } } // append-only — no updatedAt needed
);

taskUpdateSchema.index({ taskId: 1, createdAt: -1 });

applyToJSON(taskUpdateSchema);

// No update/delete route will ever be built against this model (enforced at the API-route
// layer in a later phase, per docs/04-db-models.md §4) — the append-only guarantee is a routing
// decision, not a schema-level restriction, so nothing further is added here.
module.exports = mongoose.models.TaskUpdate || mongoose.model('TaskUpdate', taskUpdateSchema);
