// Writes (or rolls back) a final-rating late-downgrade plan. Only ever reached from the CLI's
// --commit path, after its own guards (every check passing, a backup taken) have passed.
//
// Safety model — the same as scripts/synthetic-ratings/commit.js:
// - One MongoDB transaction per task: the task's change and its ledger record are committed together
//   or not at all.
// - The task is written with one conditional update: `performanceRating` (from the plain band to the
//   late-rule band) and ONE new syntheticRating.history entry by 'system:script' — which is never
//   counted as an admin edit, so the task stays final. timestamps:false, so updatedAt does not move.
//   Nothing else is written: no TaskUpdate, no notification, no reminder state.
// - That is PROVEN per task: the document is read before and after inside the same transaction;
//   every other field, and every other part of syntheticRating, must be byte-identical, or the
//   transaction aborts.
// - Idempotent: a task whose ledger record already exists, or that no longer matches the plan, is
//   skipped.
// - Rollback restores the plain band from the ledger and removes this script's history entry — only
//   for a task still exactly as this script left it; any other task is skipped, untouched, and its
//   ledger record stays active.
const mongoose = require('mongoose');
const Task = require('../../src/models/Task');
const HistoricalImportRecord = require('../../src/models/HistoricalImportRecord');
const { isFinalRating } = require('../../src/utils/syntheticRating');
const { fingerprint } = require('../synthetic-ratings/commit');
const { ledgerKeyFor, LEDGER_ACTION, LEDGER_ACTION_ROLLED_BACK, HISTORY_AUTHOR, HISTORY_NOTE, COMPLETED } = require('./plan');

const CHANGED_FIELDS = ['performanceRating', 'syntheticRating'];

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

// syntheticRating without its history, and the history on its own — compared separately.
function splitSynthetic(doc) {
  const { history = [], ...rest } = doc.syntheticRating || {};
  return { rest, history };
}

async function fixOne(item, { importBatch, now }, session) {
  const before = await Task.findById(item.taskId).session(session).lean();
  if (!before) return { outcome: 'skipped', reason: 'task no longer exists' };
  if (!isFinalRating(before.syntheticRating)) return { outcome: 'skipped', reason: 'no longer a final rating' };
  if (!COMPLETED.includes(before.status) || before.timeStatus?.type !== 'late') return { outcome: 'skipped', reason: 'no longer completed late' };
  if (before.performanceRating !== item.from || before.syntheticRating.assumedPercent !== item.assumedPercent) {
    return { outcome: 'skipped', reason: `changed since planning (band "${before.performanceRating}", ${before.syntheticRating.assumedPercent}%)` };
  }

  const entry = {
    at: now,
    by: HISTORY_AUTHOR,
    fromPercent: item.assumedPercent,
    toPercent: item.assumedPercent,
    fromRating: item.from,
    toRating: item.to,
    note: HISTORY_NOTE,
  };
  const result = await Task.updateOne(
    {
      _id: before._id,
      status: before.status,
      'timeStatus.type': 'late',
      performanceRating: item.from,
      'syntheticRating.isSynthetic': true,
      'syntheticRating.assumedPercent': item.assumedPercent,
    },
    { $set: { performanceRating: item.to }, $push: { 'syntheticRating.history': entry } },
    { session, timestamps: false, runValidators: true }
  );
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
    throw new Error(`${item.code}: expected to modify exactly 1 task, matched ${result.matchedCount} / modified ${result.modifiedCount}`);
  }

  const after = await Task.findById(before._id).session(session).lean();
  if (fingerprint(before, CHANGED_FIELDS) !== fingerprint(after, CHANGED_FIELDS)) {
    throw new Error(`${item.code}: a field other than ${CHANGED_FIELDS.join('/')} changed — aborting this task`);
  }
  const b = splitSynthetic(before);
  const a = splitSynthetic(after);
  if (fingerprint(b.rest) !== fingerprint(a.rest) || a.history.length !== b.history.length + 1 || fingerprint({ h: a.history.slice(0, -1) }) !== fingerprint({ h: b.history })) {
    throw new Error(`${item.code}: syntheticRating changed beyond one new history entry — aborting this task`);
  }
  if (after.performanceRating !== item.to || !isFinalRating(after.syntheticRating)) {
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
        flags: { status: before.status, daysLate: before.timeStatus.days },
        previous: { performanceRating: item.from, assumedPercent: item.assumedPercent, fingerprint: fingerprint(before) },
        next: { performanceRating: item.to, historyEntry: entry },
      },
    ],
    { session }
  );
  return { outcome: 'fixed' };
}

async function applyPlan(plan, { importBatch, now = new Date(), log = () => {} }) {
  const result = { fixed: 0, skipped: [] };
  for (const item of plan.items) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design: one task per transaction
    if (await HistoricalImportRecord.exists({ sourceKey: ledgerKeyFor(item.code) })) {
      result.skipped.push({ code: item.code, reason: 'ledger record already exists' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const { outcome, reason } = await inTransaction((session) => fixOne(item, { importBatch, now }, session));
    if (outcome === 'fixed') {
      result.fixed += 1;
      log(`fixed ${item.code}: ${item.from} → ${item.to} (${item.assumedPercent}%, ${item.daysLate} day(s) late)`);
    } else {
      result.skipped.push({ code: item.code, reason });
      log(`skipped ${item.code}: ${reason}`);
    }
  }
  return result;
}

const hasScriptEntry = (task, entry) =>
  (task?.syntheticRating?.history || []).some(
    (h) => h.by === HISTORY_AUTHOR && h.note === entry.note && new Date(h.at).getTime() === new Date(entry.at).getTime()
  );

// What a rollback would do for one ledger record, given the task as it is now. Pure.
function planRollback(record, task) {
  if (!task) return { action: 'ledger-only', detail: 'task no longer exists — only the ledger record is retired' };
  if (task.performanceRating !== record.next.performanceRating || !hasScriptEntry(task, record.next.historyEntry)) {
    return {
      action: 'skip-changed',
      detail: `band is now "${task.performanceRating}" (this script wrote "${record.next.performanceRating}") — changed since, left exactly as it is`,
    };
  }
  return { action: 'restore', detail: `"${task.performanceRating}" → "${record.previous.performanceRating}", this script's history entry removed` };
}

async function rollbackOne(recordId, now, session) {
  const record = await HistoricalImportRecord.findById(recordId).session(session).lean();
  if (!record || record.action !== LEDGER_ACTION) return { outcome: 'skipped', reason: 'ledger record is not an active late-downgrade correction' };
  const before = await Task.findById(record.targetId).session(session).lean();
  const decision = planRollback(record, before);
  if (decision.action === 'skip-changed') return { outcome: 'skipped', reason: decision.detail };

  let restoredExactly = null;
  if (decision.action === 'restore') {
    const entry = record.next.historyEntry;
    const result = await Task.updateOne(
      { _id: before._id, performanceRating: record.next.performanceRating },
      {
        $set: { performanceRating: record.previous.performanceRating },
        $pull: { 'syntheticRating.history': { by: HISTORY_AUTHOR, note: entry.note, at: new Date(entry.at) } },
      },
      { session, timestamps: false, runValidators: true }
    );
    if (result.matchedCount !== 1) throw new Error(`${record.taskCode}: expected to match exactly 1 task, matched ${result.matchedCount}`);
    const after = await Task.findById(before._id).session(session).lean();
    if (fingerprint(before, CHANGED_FIELDS) !== fingerprint(after, CHANGED_FIELDS)) {
      throw new Error(`${record.taskCode}: a field other than ${CHANGED_FIELDS.join('/')} changed — aborting this rollback`);
    }
    if (after.performanceRating !== record.previous.performanceRating || hasScriptEntry(after, entry)) {
      throw new Error(`${record.taskCode}: the rollback does not read back as planned — aborting this rollback`);
    }
    // True when the task is, byte for byte, the document it was before this script ran.
    restoredExactly = fingerprint(after) === record.previous.fingerprint;
  }

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
  const result = { restored: 0, ledgerOnly: 0, notRestoredExactly: [], skipped: [] };
  for (const record of records) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design: one task per transaction
    const outcome = await inTransaction((session) => rollbackOne(record._id, now, session));
    if (outcome.outcome === 'restore') {
      result.restored += 1;
      if (outcome.restoredExactly === false) result.notRestoredExactly.push(record.taskCode);
    } else if (outcome.outcome === 'ledger-only') result.ledgerOnly += 1;
    else result.skipped.push({ code: record.taskCode, reason: outcome.reason });
    log(`rollback ${record.taskCode}: ${outcome.outcome}${outcome.detail || outcome.reason ? ` — ${outcome.detail || outcome.reason}` : ''}`);
  }
  return result;
}

module.exports = { applyPlan, rollbackAll, planRollback, CHANGED_FIELDS };
