const mongoose = require('mongoose');
const applyToJSON = require('./plugins/applyToJSON');

const { Schema } = mongoose;

// docs/04-db-models.md §3 — schema is authoritative, transcribed as documented.
const timeStatusSchema = new Schema(
  {
    type: { type: String, enum: ['remaining', 'overdue', 'early', 'late'], default: 'remaining' },
    days: { type: Number, default: 0 },
  },
  { _id: false }
);

const taskSchema = new Schema(
  {
    // unique: true creates the { codeNumber: 1 } unique index (docs/02-db-design.md §10) — no
    // separate schema.index() call is added for it, to avoid Mongoose's duplicate-index warning
    codeNumber: { type: String, required: true, unique: true, trim: true },
    title: { type: String, required: true, trim: true },
    assignees: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      validate: [(arr) => arr.length > 0, 'A task needs at least one assignee'],
    },
    responsibility: { type: String, required: true, trim: true },
    deadline: { type: Date, required: true },
    status: { type: String, enum: ['ongoing', 'pending', 'complete', 'closed'], default: 'ongoing' },
    completionPercent: { type: Number, min: 0, max: 100, default: 0 },
    lastUpdateAt: { type: Date, default: null },
    timeStatus: { type: timeStatusSchema, default: () => ({}) },
    performanceRating: {
      type: String,
      enum: ['excellent', 'good', 'fair', 'weak', '-'],
      default: '-',
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Deliberately no pre('save') recalculation hooks here. Per the layering rule
// (docs/03-backend-foundation.md §2) and docs/04-db-models.md §3, computing timeStatus /
// performanceRating and keeping this document in sync after a TaskUpdate is service-layer
// business logic (task.service.js, a later phase) — not model-layer behavior.

taskSchema.index({ assignees: 1 });
taskSchema.index({ status: 1, deadline: 1 });

applyToJSON(taskSchema);

module.exports = mongoose.models.Task || mongoose.model('Task', taskSchema);
