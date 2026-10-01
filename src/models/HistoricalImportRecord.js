const mongoose = require('mongoose');
const applyToJSON = require('./plugins/applyToJSON');

const { Schema } = mongoose;

// One-off historical "Follow-up Karkardagi" import ledger (scripts/import-historical-followup.js).
// Deliberately a SEPARATE collection rather than new fields on Task/TaskUpdate: the core schemas
// stay untouched, while every imported document still carries its full provenance — inferred-date
// flags, data-quality notes, and the original raw source strings. Also doubles as the import's
// idempotency ledger (unique sourceKey) and an exact rollback list (targetId per created doc).
const historicalImportRecordSchema = new Schema(
  {
    importBatch: { type: String, required: true },
    // 'task:<code>' or 'update:<code>:<index>' — stable across re-runs, so a re-run after a
    // partial failure can tell exactly what already exists.
    sourceKey: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['task', 'taskUpdate'], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    taskCode: { type: String, required: true },
    personKey: { type: String, required: true },
    flags: { type: Schema.Types.Mixed, default: {} },
    dataQualityIssues: { type: [String], default: [] },
    raw: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

historicalImportRecordSchema.index({ targetId: 1 });

applyToJSON(historicalImportRecordSchema);

module.exports =
  mongoose.models.HistoricalImportRecord || mongoose.model('HistoricalImportRecord', historicalImportRecordSchema);
