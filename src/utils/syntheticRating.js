// The one definition of what a developer-assigned (synthetic, "تخمینی") rating is NOW — used by
// every consumer: the task service (filter, edit/remove guard, the real-rating path), the
// serializer, the KPIs (and through them the user-summary report) and both synthetic-rating scripts.
//
// A synthetic rating (models/Task.js syntheticRating, isSynthetic: true) is either:
//   - still an ESTIMATE — as the script assigned it, never edited by an admin; or
//   - FINAL — an admin changed it. From then on it is no longer an estimate: it is shown and
//     counted as a real rating, it can no longer be changed or removed, and a real rating computed
//     later does not replace it. The stored flag stays true (so its assumed percent keeps being the
//     task's effective percent — Task.getEffectivePercent), and nothing is migrated.
//
// Final means: `finalizedAt` is set (written by every admin edit from this change on), OR — for the
// edits made before this change — the history holds an admin edit: an entry whose `by` is an
// ObjectId (an admin's id; the scripts only ever write the string 'system:script') and whose
// `toPercent` is a number (a removal writes null). The real-rating replacement also writes such an
// entry, but it switches isSynthetic off at the same time, so it never counts here.
const ADMIN_EDIT_MATCH = { by: { $type: 'objectId' }, toPercent: { $type: 'number' } };

// HistoricalImportRecord ledger actions: the script's assignment (scripts/synthetic-ratings/), and
// an admin's edit that made a rating final (task.service.js editSyntheticRating).
const ASSIGN_LEDGER_ACTION = 'synthetic-rating';
const FINALIZED_LEDGER_ACTION = 'synthetic-rating-finalized';
const FINALIZED_LEDGER_BATCH = 'app:synthetic-rating-finalized';

function isObjectId(value) {
  return Boolean(value) && typeof value === 'object' && value._bsontype === 'ObjectId';
}

function isAdminEditEntry(entry) {
  return Boolean(entry) && isObjectId(entry.by) && typeof entry.toPercent === 'number';
}

function hasAdminEdit(syntheticRating) {
  return (syntheticRating?.history || []).some(isAdminEditEntry);
}

// `syntheticRating` — the task's subdocument (a Mongoose subdocument or a lean object), or undefined.
function isFinalRating(syntheticRating) {
  if (syntheticRating?.isSynthetic !== true) return false;
  return Boolean(syntheticRating.finalizedAt) || hasAdminEdit(syntheticRating);
}

function isEstimateRating(syntheticRating) {
  return syntheticRating?.isSynthetic === true && !isFinalRating(syntheticRating);
}

// The same two rules as MongoDB conditions, for the list filter and the guarded writes.
// A missing finalizedAt matches null.
const ESTIMATE_CONDITION = {
  'syntheticRating.isSynthetic': true,
  'syntheticRating.finalizedAt': null,
  'syntheticRating.history': { $not: { $elemMatch: ADMIN_EDIT_MATCH } },
};
const NOT_ESTIMATE_CONDITION = {
  $or: [
    { 'syntheticRating.isSynthetic': { $ne: true } },
    { 'syntheticRating.finalizedAt': { $ne: null } },
    { 'syntheticRating.history': { $elemMatch: ADMIN_EDIT_MATCH } },
  ],
};

module.exports = {
  ADMIN_EDIT_MATCH,
  ASSIGN_LEDGER_ACTION,
  FINALIZED_LEDGER_ACTION,
  FINALIZED_LEDGER_BATCH,
  ESTIMATE_CONDITION,
  NOT_ESTIMATE_CONDITION,
  isAdminEditEntry,
  hasAdminEdit,
  isFinalRating,
  isEstimateRating,
};
