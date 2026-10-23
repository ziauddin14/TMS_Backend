// Writes (or rolls back) a reopen-stuck-complete plan. Only ever reached from the CLI's --commit
// path, after its own guards (every check passing, a backup taken) have passed.
//
// Safety model — the same as scripts/final-rating-late-downgrade/commit.js:
// - One MongoDB transaction per task: the task's repair and its ledger record are committed together
//   or not at all.
// - The task is written with one conditional update: status (ongoing/pending), timeStatus (open),
//   performanceRating, completedAt removed and — only for a final rating whose band changes — ONE
//   syntheticRating.history entry by 'system:script'. timestamps:false, so updatedAt does not move.
//   Nothing else is written: no TaskUpdate, no notification, no reminder or receipt state.
// - That is PROVEN per task: the document is read before and after inside the same transaction;
//   every other field, and every other part of syntheticRating, must be byte-identical, or the
//   transaction aborts.
// - Idempotent: a task whose ledger record already exists, or that no longer matches the plan, is
//   skipped.
// - Rollback puts the task back exactly as the repair found it — only while nobody has touched it
//   since: no new update, not completed or closed, the same rating. The reminder engine's own daily
//   changes (the open time status, ongoing -> pending) do not count as touching it. Any other task
//   is skipped, untouched, and its ledger record stays active.
const mongoose = require('mongoose');
const Task = require('../../src/models/Task');
const HistoricalImportRecord = require('../../src/models/HistoricalImportRecord');
const { fingerprint } = require('../synthetic-ratings/commit');
const {
  ledgerKeyFor,
  sameTimeStatus,
  time,
  LEDGER_ACTION,
  LEDGER_ACTION_ROLLED_BACK,
  LEDGER_KIND,
  PERSON_KEY,
  HISTORY_AUTHOR,
  HISTORY_NOTE,
} = require('./plan');

const CHANGED_FIELDS = ['status', 'timeStatus', 'performanceRating', 'completedAt', 'syntheticRating'];
const OPEN = ['ongoing', 'pending'];

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

// The only change syntheticRating may see: none, or exactly one entry added / removed at the end.
function syntheticChangedBy(before, after, addedEntries) {
  if (!before.syntheticRating && !after.syntheticRating) return true;
  const b = splitSynthetic(before);
  const a = splitSynthetic(after);
  if (fingerprint(b.rest) !== fingerprint(a.rest)) return false;
  const [longer, shorter] = addedEntries >= 0 ? [a.history, b.history] : [b.history, a.history];
  return longer.length === shorter.length + Math.abs(addedEntries) && fingerprint({ h: longer.slice(0, shorter.length) }) === fingerprint({ h: shorter });
}

async function repairOne(item, { importBatch, now }, session) {
  const before = await Task.findById(item.taskId).session(session).lean();
  if (!before) return { outcome: 'skipped', reason: 'task no longer exists' };
  if (
    before.status !== 'complete' ||
    before.completionPercent !== item.completionPercent ||
    time(before.lastUpdateAt) !== time(item.lastUpdateAt) ||
    (before.performanceRating ?? null) !== item.from.performanceRating
  ) {
    return { outcome: 'skipped', reason: `changed since planning (${before.status}, ${before.completionPercent}%, "${before.performanceRating}")` };
  }

  const entry =
    item.ratingKind === 'final' && item.from.performanceRating !== item.to.performanceRating
      ? {
          at: now,
          by: HISTORY_AUTHOR,
          fromPercent: item.assumedPercent,
          toPercent: item.assumedPercent,
          fromRating: item.from.performanceRating,
          toRating: item.to.performanceRating,
          note: HISTORY_NOTE,
        }
      : null;
  const update = {
    $set: { status: item.to.status, timeStatus: item.to.timeStatus, performanceRating: item.to.performanceRating },
    $unset: { completedAt: '' },
  };
  if (entry) update.$push = { 'syntheticRating.history': entry };
  const result = await Task.updateOne(
    { _id: before._id, status: 'complete', completionPercent: item.completionPercent, lastUpdateAt: before.lastUpdateAt ?? null, performanceRating: before.performanceRating },
    update,
    { session, timestamps: false, runValidators: true }
  );
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
    throw new Error(`${item.code}: expected to modify exactly 1 task, matched ${result.matchedCount} / modified ${result.modifiedCount}`);
  }

  const after = await Task.findById(before._id).session(session).lean();
  if (fingerprint(before, CHANGED_FIELDS) !== fingerprint(after, CHANGED_FIELDS)) {
    throw new Error(`${item.code}: a field other than ${CHANGED_FIELDS.join('/')} changed — aborting this task`);
  }
  if (!syntheticChangedBy(before, after, entry ? 1 : 0)) {
    throw new Error(`${item.code}: syntheticRating changed beyond the planned history entry — aborting this task`);
  }
  if (after.status !== item.to.status || !sameTimeStatus(after.timeStatus, item.to.timeStatus) || after.performanceRating !== item.to.performanceRating || 'completedAt' in after) {
    throw new Error(`${item.code}: the written values do not read back as planned — aborting this task`);
  }

  await HistoricalImportRecord.create(
    [
      {
        importBatch,
        sourceKey: ledgerKeyFor(item.code),
        kind: LEDGER_KIND,
        action: LEDGER_ACTION,
        targetId: before._id,
        taskCode: item.code,
        personKey: PERSON_KEY,
        flags: { ratingKind: item.ratingKind, newStatus: item.to.status },
        previous: {
          status: before.status,
          completionPercent: before.completionPercent,
          lastUpdateAt: before.lastUpdateAt ?? null,
          timeStatus: before.timeStatus ?? null,
          performanceRating: before.performanceRating,
          completedAt: before.completedAt ?? null,
          fingerprint: fingerprint(before),
        },
        next: { status: item.to.status, timeStatus: item.to.timeStatus, performanceRating: item.to.performanceRating, historyEntry: entry },
      },
    ],
    { session }
  );
  return { outcome: 'repaired' };
}

async function applyPlan(plan, { importBatch, now = new Date(), log = () => {} }) {
  const result = { repaired: 0, skipped: [] };
  for (const item of plan.items) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design: one task per transaction
    if (await HistoricalImportRecord.exists({ sourceKey: ledgerKeyFor(item.code) })) {
      result.skipped.push({ code: item.code, reason: 'ledger record already exists' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const { outcome, reason } = await inTransaction((session) => repairOne(item, { importBatch, now }, session));
    if (outcome === 'repaired') {
      result.repaired += 1;
      log(`reopened ${item.code}: complete → ${item.to.status} (${item.completionPercent}%, ${item.to.timeStatus.type} ${item.to.timeStatus.days}), rating "${item.from.performanceRating}" → "${item.to.performanceRating}"`);
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
  const { previous, next } = record;
  const reasons = [];
  if (!OPEN.includes(task.status)) reasons.push(`status is now "${task.status}"`);
  if (task.completionPercent !== previous.completionPercent || time(task.lastUpdateAt) !== time(previous.lastUpdateAt)) reasons.push('a new update was posted since');
  if (task.performanceRating !== next.performanceRating) reasons.push(`the rating is now "${task.performanceRating}" (this script wrote "${next.performanceRating}")`);
  if (task.completedAt) reasons.push('completed again since');
  if (next.historyEntry && !hasScriptEntry(task, next.historyEntry)) reasons.push("this script's history entry is gone");
  if (reasons.length) return { action: 'skip-changed', detail: `${reasons.join('; ')} — changed since, left exactly as it is` };
  return { action: 'restore', detail: `${task.status} → complete, "${task.performanceRating}" → "${previous.performanceRating}"${next.historyEntry ? ", this script's history entry removed" : ''}` };
}

async function rollbackOne(recordId, now, session) {
  const record = await HistoricalImportRecord.findById(recordId).session(session).lean();
  if (!record || record.action !== LEDGER_ACTION) return { outcome: 'skipped', reason: 'ledger record is not an active reopen repair' };
  const before = await Task.findById(record.targetId).session(session).lean();
  const decision = planRollback(record, before);
  if (decision.action === 'skip-changed') return { outcome: 'skipped', reason: decision.detail };

  let restoredExactly = null;
  if (decision.action === 'restore') {
    const { previous, next } = record;
    const set = { status: 'complete', timeStatus: previous.timeStatus, performanceRating: previous.performanceRating };
    if (previous.completedAt) set.completedAt = new Date(previous.completedAt);
    const update = { $set: set };
    if (next.historyEntry) update.$pull = { 'syntheticRating.history': { by: HISTORY_AUTHOR, note: next.historyEntry.note, at: new Date(next.historyEntry.at) } };
    const result = await Task.updateOne(
      { _id: before._id, status: before.status, completionPercent: previous.completionPercent, performanceRating: next.performanceRating },
      update,
      { session, timestamps: false, runValidators: true }
    );
    if (result.matchedCount !== 1) throw new Error(`${record.taskCode}: expected to match exactly 1 task, matched ${result.matchedCount}`);
    const after = await Task.findById(before._id).session(session).lean();
    if (fingerprint(before, CHANGED_FIELDS) !== fingerprint(after, CHANGED_FIELDS)) {
      throw new Error(`${record.taskCode}: a field other than ${CHANGED_FIELDS.join('/')} changed — aborting this rollback`);
    }
    if (!syntheticChangedBy(before, after, next.historyEntry ? -1 : 0)) {
      throw new Error(`${record.taskCode}: syntheticRating changed beyond removing this script's entry — aborting this rollback`);
    }
    if (after.status !== 'complete' || after.performanceRating !== previous.performanceRating || !sameTimeStatus(after.timeStatus, previous.timeStatus)) {
      throw new Error(`${record.taskCode}: the rollback does not read back as planned — aborting this rollback`);
    }
    // True when the task is, byte for byte, the document it was before the repair. False when the
    // live app changed something else meanwhile (the reminder engine's save moves updatedAt; a
    // receipt reminder may have been recorded).
    restoredExactly = fingerprint(after) === previous.fingerprint;
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
