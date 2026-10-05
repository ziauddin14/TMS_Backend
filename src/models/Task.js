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

// A developer-assigned ("synthetic") rating — NOT a real one. Additive and optional: a task only
// carries this subdocument once a rating has been assigned to it by hand/script
// (scripts/assign-synthetic-ratings.js), and every document without it behaves exactly as before.
// The task's real fields (status, completionPercent, ...) are never altered by it; only
// performanceRating — still the single field every screen and report reads — is set from
// assumedPercent, and this subdocument is what marks that value as not real.
const syntheticRatingHistorySchema = new Schema(
  {
    at: { type: Date, required: true },
    by: { type: Schema.Types.Mixed, required: true },
    fromPercent: { type: Number, default: null },
    toPercent: { type: Number, default: null },
    fromRating: { type: String, default: null },
    toRating: { type: String, default: null },
    note: { type: String, default: null },
  },
  { _id: false }
);

const syntheticRatingSchema = new Schema(
  {
    isSynthetic: { type: Boolean, required: true },
    assumedPercent: { type: Number, min: 0, max: 100, required: true },
    assignedAt: { type: Date, required: true },
    // An admin User's ObjectId, or a marker string such as 'system:script'.
    assignedBy: { type: Schema.Types.Mixed, required: true },
    reason: { type: String, default: null },
    history: { type: [syntheticRatingHistorySchema], default: [] },
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
    // Absent (undefined) on every task that has no synthetic rating — see syntheticRatingSchema.
    syntheticRating: { type: syntheticRatingSchema, default: undefined },
  },
  { timestamps: true }
);

// The percentage a task should be counted at: the developer-assumed one while the task carries a
// synthetic rating, otherwise its real completionPercent. A plain accessor (works on a document or
// a lean object), kept here so it is the one place any future KPI maths takes a percentage from.
taskSchema.statics.getEffectivePercent = function getEffectivePercent(task) {
  return task?.syntheticRating?.isSynthetic ? task.syntheticRating.assumedPercent : task.completionPercent;
};

// Deliberately no pre('save') recalculation hooks here. Per the layering rule
// (docs/03-backend-foundation.md §2) and docs/04-db-models.md §3, computing timeStatus /
// performanceRating and keeping this document in sync after a TaskUpdate is service-layer
// business logic (task.service.js, a later phase) — not model-layer behavior.

taskSchema.index({ assignees: 1 });
taskSchema.index({ status: 1, deadline: 1 });

applyToJSON(taskSchema);

module.exports = mongoose.models.Task || mongoose.model('Task', taskSchema);
