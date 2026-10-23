// Finds the tasks the code before the reopen fix left in the wrong state, and plans what
// scripts/reopen-stuck-complete.js would write — pure functions over already-loaded data, no
// database access (so the whole decision is unit-tested and a dry run can never write).
// scripts/stuck-complete-dry-run.js prints the same plan and never writes at all.
//
// Before the fix, an update below 100% on a complete task changed its percent but never its status:
// the task stayed "مکمل" at, say, 0%, rated from that percent and dated "late" by that update
// (task 261006). The app now reopens such a task itself (task.service.js applyNewUpdateToTask);
// this finds the ones already stuck:
//
//   A. stuck   — status complete, percent below 100, reached 100% earlier: REPAIRED by the script,
//                exactly as the app now reopens a task — status ongoing, or pending once its
//                deadline has passed (applyOverdueRule); an open time status; the real rating '-'
//                (an estimate stays, a final rating goes back to the plain band of its percent);
//                completedAt removed. No notification. A stuck task the rule cannot repair with
//                confidence (imported, no updates, its percent not that of its latest update,
//                never at 100%) is an ANOMALY: listed, never written, and any anomaly makes the
//                checks fail.
//   B. late only because of a later update — status complete at 100%, shown late, but the update
//                that took it to 100% was on or before the deadline (a later update, e.g. a
//                comment, moved the date it was judged by). REPORT ONLY.
//   C. closed after dropping below 100% — status closed, below 100%, whose updates reached 100%
//                and later went lower. REPORT ONLY: closing it was an admin's decision.
const { computeTimeStatus, applyOverdueRule, ratingForPercent } = require('../../src/services/task.service');
const { isFinalRating } = require('../../src/utils/syntheticRating');

const LEDGER_ACTION = 'reopen-stuck-complete';
const LEDGER_ACTION_ROLLED_BACK = 'reopen-stuck-complete-rolled-back';
const LEDGER_KIND = 'taskRepair';
const ledgerKeyFor = (code) => `${LEDGER_ACTION}:${code}`;
// Who the ledger records the repair for (HistoricalImportRecord.personKey is required).
const PERSON_KEY = 'app:reopen-stuck-complete';
// The history entry added when a FINAL rating's band goes back to the plain one. A string author,
// so it is never counted as an admin edit: the rating stays final.
const HISTORY_AUTHOR = 'system:script';
const HISTORY_NOTE = 'final rating band back to the plain band — task reopened (reopen-stuck-complete)';

const time = (value) => (value ? new Date(value).getTime() : null);
const iso = (value) => (value ? new Date(value).toISOString() : null);
const sameTimeStatus = (a, b) => (a?.type ?? null) === (b?.type ?? null) && (a?.days ?? null) === (b?.days ?? null);

// What a reopened task is rated: '-' for a real rating (a completed rating no longer applies); an
// estimate stays as it is; a final rating keeps its percent and goes back to its plain band.
function ratingAfterReopen(task) {
  const sr = task.syntheticRating;
  if (sr?.isSynthetic === true) {
    if (isFinalRating(sr)) return { kind: 'final', to: ratingForPercent(sr.assumedPercent) };
    return { kind: 'estimate', to: task.performanceRating };
  }
  return { kind: sr ? 'real (estimate replaced)' : 'real', to: '-' };
}

// The update that last took the task to 100% or more: the first of the last unbroken run of
// updates at 100%+ — null if it never got there. `updates` are oldest first.
function lastCompletion(updates) {
  let start = null;
  updates.forEach((update, index) => {
    if (update.completionPercent >= 100 && (index === 0 || updates[index - 1].completionPercent < 100)) start = update;
  });
  return start;
}

function stuckRow(task, updates, { imported, now }) {
  const latest = updates[updates.length - 1] || null;
  const reached100 = updates.some((u) => u.completionPercent >= 100);
  const problems = [];
  if (imported) problems.push('an imported task');
  if (!latest) problems.push('no updates at all');
  if (latest && latest.completionPercent !== task.completionPercent) problems.push(`its latest update is ${latest.completionPercent}%, the task says ${task.completionPercent}%`);
  if (latest && !reached100) problems.push('never reached 100% in its updates');
  if (problems.length) return { anomaly: `${task.codeNumber}: complete at ${task.completionPercent}% — ${problems.join('; ')} — left alone` };

  const timeStatus = computeTimeStatus({ ...task, status: 'ongoing' }, now);
  const reopened = { status: 'ongoing', timeStatus };
  applyOverdueRule(reopened);
  const rating = ratingAfterReopen(task);
  return {
    item: {
      taskId: String(task._id),
      code: task.codeNumber,
      completionPercent: task.completionPercent,
      deadline: iso(task.deadline),
      lastUpdateAt: iso(task.lastUpdateAt),
      reached100At: iso(lastCompletion(updates.slice(0, -1))?.createdAt),
      ratingKind: rating.kind,
      assumedPercent: task.syntheticRating?.assumedPercent ?? null,
      from: { status: task.status, timeStatus: task.timeStatus ? { type: task.timeStatus.type, days: task.timeStatus.days } : null, performanceRating: task.performanceRating ?? null },
      to: { status: reopened.status, timeStatus, performanceRating: rating.to },
    },
  };
}

// tasks           — every Task with status complete, or closed below 100% (lean)
// updatesByTaskId — Map(taskId -> that task's TaskUpdates { completionPercent, createdAt }, oldest first)
// importedTaskIds — Set of the ids of tasks the historical import created
// ledgerRecords   — this script's ACTIVE ledger records
// now             — the moment the open time status is computed for
function buildPlan({ tasks, updatesByTaskId = new Map(), importedTaskIds = new Set(), ledgerRecords = [], now = new Date() }) {
  const items = [];
  const anomalies = [];
  const lateOnlyByLaterUpdate = [];
  const closedAfterDrop = [];

  tasks.forEach((task) => {
    const id = String(task._id);
    const updates = updatesByTaskId.get(id) || [];
    const imported = importedTaskIds.has(id);

    if (task.status === 'complete' && task.completionPercent < 100) {
      const { item, anomaly } = stuckRow(task, updates, { imported, now });
      if (item) items.push(item);
      else anomalies.push(anomaly);
      return;
    }

    if (task.status === 'complete' && task.timeStatus?.type === 'late' && !task.completedAt) {
      const completion = lastCompletion(updates);
      if (!completion) return;
      const atCompletion = computeTimeStatus({ status: 'complete', deadline: task.deadline, completedAt: completion.createdAt });
      if (atCompletion.type !== 'early') return;
      lateOnlyByLaterUpdate.push({
        code: task.codeNumber,
        shownLateDays: task.timeStatus.days,
        completedOn: iso(completion.createdAt),
        daysBeforeDeadline: atCompletion.days,
        lastUpdateAt: iso(task.lastUpdateAt),
        imported,
      });
      return;
    }

    if (task.status === 'closed' && task.completionPercent < 100) {
      const reachedAt = updates.findIndex((u) => u.completionPercent >= 100);
      if (reachedAt === -1) return;
      const dropped = updates.slice(reachedAt + 1).find((u) => u.completionPercent < 100);
      if (!dropped) return;
      closedAfterDrop.push({
        code: task.codeNumber,
        completionPercent: task.completionPercent,
        reached100At: iso(updates[reachedAt].createdAt),
        droppedAt: iso(dropped.createdAt),
        closedAt: iso(task.closedAt),
        imported,
      });
    }
  });

  const byNewStatus = items.reduce((acc, i) => ({ ...acc, [i.to.status]: (acc[i.to.status] || 0) + 1 }), {});
  const checks = [
    {
      label: 'every planned task is complete below 100%, reached 100% earlier, and its latest update is its percent',
      ok: items.every((i) => i.from.status === 'complete' && i.completionPercent < 100 && i.reached100At !== null),
      detail: `${items.length} planned`,
    },
    { label: 'no stuck task the rule cannot repair with confidence', ok: anomalies.length === 0, detail: anomalies.length ? anomalies.join('; ') : 'none' },
  ];

  return {
    items,
    anomalies,
    lateOnlyByLaterUpdate,
    closedAfterDrop,
    byNewStatus,
    checks,
    ok: checks.every((c) => c.ok),
    totals: {
      toRepair: items.length,
      anomalies: anomalies.length,
      alreadyRepaired: ledgerRecords.length,
      lateOnlyByLaterUpdate: lateOnlyByLaterUpdate.length,
      closedAfterDrop: closedAfterDrop.length,
    },
  };
}

module.exports = {
  buildPlan,
  ratingAfterReopen,
  lastCompletion,
  ledgerKeyFor,
  sameTimeStatus,
  time,
  LEDGER_ACTION,
  LEDGER_ACTION_ROLLED_BACK,
  LEDGER_KIND,
  PERSON_KEY,
  HISTORY_AUTHOR,
  HISTORY_NOTE,
};
