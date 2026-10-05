// Writes (or rolls back) a synthetic-rating plan. Only ever reached from the CLI's --commit path,
// after its own guards (every check passing, a backup taken) have passed.
//
// Safety model:
// - One MongoDB transaction per task: the task's two changed fields and its ledger record are
//   committed together or not at all.
// - The task is written with a targeted $set of exactly `performanceRating` and `syntheticRating`,
//   and with timestamps:false so `updatedAt` does not move (it can be the reference date for a
//   closed task's timeStatus). Nothing else is written: no TaskUpdate, no notification, no reminder
//   state, no status/completionPercent/lastUpdateAt.
// - That is PROVEN per task, not assumed: the document is read before and after inside the same
//   transaction and every other field must be byte-identical, or the transaction aborts.
// - Idempotent: a task that is already synthetic, or whose ledger record already exists, is skipped.
// - Rollback restores from the ledger's stored previous values, and never overwrites a rating that
//   has changed since (a real update or close in the meantime) — it only removes the marker then.
const crypto = require('crypto');
const mongoose = require('mongoose');
const Task = require('../../src/models/Task');
const HistoricalImportRecord = require('../../src/models/HistoricalImportRecord');
const { isUnrated, isSynthetic, ledgerKeyFor, LEDGER_ACTION, LEDGER_ACTION_ROLLED_BACK } = require('./plan');

const CHANGED_FIELDS = ['performanceRating', 'syntheticRating'];

// A stable hash of a lean document (canonical Extended JSON, so ObjectIds/Dates are exact),
// optionally ignoring some top-level fields.
function fingerprint(doc, omit = []) {
  const copy = { ...doc };
  omit.forEach((key) => delete copy[key]);
  const canonical = mongoose.mongo.BSON.EJSON.stringify(copy, { relaxed: false });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function assignOne(item, { importBatch, neverTouchCodes }, session) {
  const before = await Task.findById(item.taskId).session(session).lean();
  if (!before) return { outcome: 'skipped', reason: 'task no longer exists' };
  if (neverTouchCodes.includes(before.codeNumber)) throw new Error(`${before.codeNumber} is on the never-touch list — refusing`);
  if (isSynthetic(before)) return { outcome: 'skipped', reason: 'already synthetic' };
  if (!isUnrated(before)) return { outcome: 'skipped', reason: `now has a real rating (${before.performanceRating})` };
  if (before.status !== item.status) return { outcome: 'skipped', reason: `status changed since planning (${item.status} → ${before.status})` };

  const result = await Task.updateOne(
    { _id: before._id, status: item.status, performanceRating: { $in: ['-', null] }, 'syntheticRating.isSynthetic': { $ne: true } },
    { $set: { performanceRating: item.newRating, syntheticRating: item.syntheticRating } },
    { session, timestamps: false, runValidators: true }
  );
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
    throw new Error(`${item.code}: expected to modify exactly 1 task, matched ${result.matchedCount} / modified ${result.modifiedCount}`);
  }

  const after = await Task.findById(before._id).session(session).lean();
  if (fingerprint(before, CHANGED_FIELDS) !== fingerprint(after, CHANGED_FIELDS)) {
    throw new Error(`${item.code}: a field other than ${CHANGED_FIELDS.join('/')} changed — aborting this task`);
  }
  if (after.performanceRating !== item.newRating || after.syntheticRating?.assumedPercent !== item.assumedPercent) {
    throw new Error(`${item.code}: the written values do not read back as planned — aborting this task`);
  }

  await HistoricalImportRecord.create(
    [
      {
        importBatch,
        sourceKey: ledgerKeyFor(item.code),
        kind: 'syntheticRating',
        action: LEDGER_ACTION,
        targetId: before._id,
        taskCode: item.code,
        personKey: item.personKey,
        flags: { group: item.group, importFlags: item.importFlags },
        previous: {
          performanceRating: before.performanceRating ?? null,
          hadPerformanceRatingField: before.performanceRating !== undefined,
          syntheticRating: before.syntheticRating ?? null,
          // Unchanged by this script — recorded so a later reader can see what was true then.
          status: before.status,
          completionPercent: before.completionPercent,
          lastUpdateAt: before.lastUpdateAt ?? null,
          updatedAt: before.updatedAt ?? null,
          fingerprint: fingerprint(before),
        },
        next: {
          group: item.group,
          performanceRating: item.newRating,
          assumedPercent: item.assumedPercent,
          syntheticRating: item.syntheticRating,
        },
      },
    ],
    { session }
  );

  return { outcome: 'assigned' };
}

async function inTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let value;
    await session.withTransaction(async () => {
      value = await work(session);
    });
    return value;
  } finally {
    await session.endSession();
  }
}

async function applyPlan(plan, { importBatch, neverTouchCodes, log = () => {} }) {
  const result = { assigned: 0, skipped: [] };

  for (const item of plan.items) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design: one task per transaction
    if (await HistoricalImportRecord.exists({ sourceKey: ledgerKeyFor(item.code) })) {
      result.skipped.push({ code: item.code, reason: 'ledger record already exists' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const { outcome, reason } = await inTransaction((session) => assignOne(item, { importBatch, neverTouchCodes }, session));
    if (outcome === 'assigned') {
      result.assigned += 1;
      log(`assigned ${item.code}: ${item.performanceRating ?? '(unset)'} → ${item.newRating} (assumed ${item.assumedPercent}%)`);
    } else {
      result.skipped.push({ code: item.code, reason });
      log(`skipped ${item.code}: ${reason}`);
    }
  }

  return result;
}

// What a rollback would do for one ledger record, given the task as it is now. Pure — used for
// the rollback dry run as well as by rollbackOne below.
function planRollback(record, task) {
  if (!task) return { action: 'ledger-only', detail: 'task no longer exists — only the ledger record is closed' };
  if (!task.syntheticRating) return { action: 'ledger-only', detail: 'task carries no synthetic rating any more — only the ledger record is closed' };

  const untouchedSinceAssignment =
    isSynthetic(task) &&
    task.performanceRating === record.next.performanceRating &&
    task.syntheticRating.assumedPercent === record.next.assumedPercent;
  if (!untouchedSinceAssignment) {
    return {
      action: 'remove-marker-only',
      detail: `rating is now "${task.performanceRating}" (assigned: "${record.next.performanceRating}") — it changed after assignment, so it is kept and only the synthetic marker is removed`,
    };
  }
  return {
    action: 'restore',
    detail: `performanceRating "${task.performanceRating}" → "${record.previous.performanceRating ?? '(unset)'}", synthetic marker removed`,
  };
}

async function rollbackOne(recordId, now, session) {
  const record = await HistoricalImportRecord.findById(recordId).session(session).lean();
  if (!record || record.action !== LEDGER_ACTION) return { outcome: 'skipped', reason: 'ledger record is not an active synthetic rating' };

  const before = await Task.findById(record.targetId).session(session).lean();
  const decision = planRollback(record, before);
  let restoredExactly = null;

  if (decision.action !== 'ledger-only') {
    const update = { $unset: { syntheticRating: 1 } };
    if (decision.action === 'restore') {
      if (record.previous.hadPerformanceRatingField === false) update.$unset.performanceRating = 1;
      else update.$set = { performanceRating: record.previous.performanceRating };
    }
    const result = await Task.updateOne({ _id: before._id }, update, { session, timestamps: false, runValidators: true });
    if (result.matchedCount !== 1) throw new Error(`${record.taskCode}: expected to match exactly 1 task, matched ${result.matchedCount}`);

    const after = await Task.findById(before._id).session(session).lean();
    if (fingerprint(before, CHANGED_FIELDS) !== fingerprint(after, CHANGED_FIELDS)) {
      throw new Error(`${record.taskCode}: a field other than ${CHANGED_FIELDS.join('/')} changed — aborting this rollback`);
    }
    if (after.syntheticRating !== undefined) throw new Error(`${record.taskCode}: the synthetic marker is still present — aborting this rollback`);
    // True when the task is, byte for byte, the document it was before the rating was assigned.
    restoredExactly = fingerprint(after) === record.previous.fingerprint;
  }

  // The record is kept as an audit trail but retired: its key is freed so the task can be given a
  // synthetic rating again later.
  await HistoricalImportRecord.updateOne(
    { _id: record._id },
    {
      $set: {
        action: LEDGER_ACTION_ROLLED_BACK,
        sourceKey: `${record.sourceKey}:rolled-back:${now.toISOString()}`,
        'flags.rollback': { at: now, action: decision.action, detail: decision.detail, restoredExactly },
      },
    },
    { session }
  );

  return { outcome: decision.action, detail: decision.detail, restoredExactly };
}

async function rollbackAll({ now, log = () => {} }) {
  const records = await HistoricalImportRecord.find({ action: LEDGER_ACTION }).select('_id taskCode').sort({ taskCode: 1 }).lean();
  const result = { restored: 0, markerOnly: 0, ledgerOnly: 0, notRestoredExactly: [], skipped: [] };

  for (const record of records) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design: one task per transaction
    const outcome = await inTransaction((session) => rollbackOne(record._id, now, session));
    if (outcome.outcome === 'restore') {
      result.restored += 1;
      if (outcome.restoredExactly === false) result.notRestoredExactly.push(record.taskCode);
    } else if (outcome.outcome === 'remove-marker-only') result.markerOnly += 1;
    else if (outcome.outcome === 'ledger-only') result.ledgerOnly += 1;
    else result.skipped.push({ code: record.taskCode, reason: outcome.reason });
    log(`rollback ${record.taskCode}: ${outcome.outcome}${outcome.detail ? ` — ${outcome.detail}` : ''}`);
  }

  return result;
}

module.exports = { applyPlan, rollbackAll, planRollback, fingerprint, CHANGED_FIELDS };
