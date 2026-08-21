const mongoose = require('mongoose');
const applyToJSON = require('./plugins/applyToJSON');

const { Schema } = mongoose;

// docs/04-db-models.md §6 — schema is authoritative, transcribed as documented.
const counterSchema = new Schema({
  _id: { type: String, required: true }, // e.g. "taskCode-2608"
  seq: { type: Number, default: 0 },
});

// Single documented exception to "no logic in models" (docs/04-db-models.md §6): this is a pure,
// self-contained atomic DB operation on the schema's own document, not business logic about
// tasks — task.service.js (a later phase) calls this when creating a task.
counterSchema.statics.getNextCodeNumber = async function getNextCodeNumber() {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const key = `taskCode-${yymm}`;
  const doc = await this.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  return `${yymm}${String(doc.seq).padStart(2, '0')}`;
};

applyToJSON(counterSchema);

module.exports = mongoose.models.Counter || mongoose.model('Counter', counterSchema);
