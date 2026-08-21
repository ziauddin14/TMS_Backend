const mongoose = require('mongoose');
const applyToJSON = require('./plugins/applyToJSON');

const { Schema } = mongoose;

// docs/04-db-models.md §5 — schema is authoritative, transcribed as documented.
const lookupListSchema = new Schema(
  {
    listType: { type: String, enum: ['responsibility'], required: true },
    value: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

lookupListSchema.index({ listType: 1, isActive: 1, sortOrder: 1 });
lookupListSchema.index({ listType: 1, value: 1 }, { unique: true }); // no duplicate values within a list

applyToJSON(lookupListSchema);

module.exports = mongoose.models.LookupList || mongoose.model('LookupList', lookupListSchema);
