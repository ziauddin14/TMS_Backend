// The READ-ONLY review behind scripts/finalized-estimates-dry-run.js: which synthetic ("تخمینی")
// ratings the app will treat as FINAL from existing data alone (src/utils/syntheticRating.js), and
// everything that does not fit the rule cleanly. Pure — takes already-loaded lean documents,
// returns plain lists — so it is fully unit-tested and can never write anything.
//
// The five lists:
//   1. becomesFinal          — still synthetic, and final by the shared rule (finalizedAt is set, or
//                              the history holds an admin edit). The app shows and counts these as
//                              real ratings from the deploy on.
//   2. editedThenRemoved     — an admin edited the estimate, and it was removed later. Unrated now;
//                              nothing changes for them (listed for information).
//   3. editedThenReplacedByReal — an admin edited it, then a real rating replaced it (close / 100%).
//                              Real now; nothing changes for them (listed for information).
//   4. ambiguous             — data the rule cannot classify with confidence; decide by hand.
//   5. activityWithoutHistory — an "estimate changed" entry in the activity log with no matching
//                              admin edit in that task's history.
const { isAdminEditEntry, isEstimateRating, isFinalRating } = require('../../src/utils/syntheticRating');

const KNOWN_STRING_AUTHORS = ['system:script', 'system'];
const REPLACEMENT_NOTE = 'synthetic rating replaced by the real rating';
// How far apart an activity-log entry and its history entry may be (they are written by the same
// request, milliseconds apart; the margin only absorbs clock noise).
const ACTIVITY_MATCH_WINDOW_MS = 10 * 60 * 1000;

const isObjectId = (value) => Boolean(value) && typeof value === 'object' && value._bsontype === 'ObjectId';
const isReplacementEntry = (entry) => typeof entry?.note === 'string' && entry.note.startsWith(REPLACEMENT_NOTE);
const isRemovalEntry = (entry) => entry?.toPercent === null && entry?.toRating === '-';
const time = (value) => (value ? new Date(value).toISOString() : null);

// The admin edits of a task: admin-authored entries with a percent, minus the real-rating replacement.
function adminEditsOf(history) {
  return history.filter((entry) => isAdminEditEntry(entry) && !isReplacementEntry(entry));
}

function summarize(task) {
  return {
    code: task.codeNumber,
    status: task.status,
    completionPercent: task.completionPercent,
    performanceRating: task.performanceRating ?? null,
    assumedPercent: task.syntheticRating?.assumedPercent ?? null,
  };
}

function editSummary(edits) {
  const last = edits[edits.length - 1];
  return {
    adminEdits: edits.length,
    lastEditAt: last ? time(last.at) : null,
    lastEditorId: last ? String(last.by) : null,
    lastEdit: last ? `${last.fromPercent ?? '-'}% → ${last.toPercent}%` : null,
  };
}

// tasks          — every Task that has a syntheticRating (lean)
// assignRecords  — the assign script's ACTIVE ledger records (action 'synthetic-rating'), lean
// activityEvents — ActivityEvent documents of type SYNTHETIC_RATING_EDITED, lean
function classify({ tasks, assignRecords = [], activityEvents = [] }) {
  const assignByTaskId = new Map(assignRecords.map((record) => [String(record.targetId), record]));
  const lists = { becomesFinal: [], editedThenRemoved: [], editedThenReplacedByReal: [], ambiguous: [], activityWithoutHistory: [] };
  let stillEstimates = 0;
  let syntheticRatedBefore = 0;
  let syntheticRatedAfter = 0;

  tasks.forEach((task) => {
    const sr = task.syntheticRating;
    if (!sr) return;
    const history = sr.history || [];
    const edits = adminEditsOf(history);
    const last = history[history.length - 1];
    const reasons = [];
    const rated = task.performanceRating && task.performanceRating !== '-';
    if (sr.isSynthetic === true && rated) syntheticRatedBefore += 1;
    if (isEstimateRating(sr) && rated) syntheticRatedAfter += 1;

    const strangeAuthors = history.filter((entry) => !isObjectId(entry.by) && !KNOWN_STRING_AUTHORS.includes(entry.by));
    if (strangeAuthors.length) reasons.push(`history has ${strangeAuthors.length} entr${strangeAuthors.length === 1 ? 'y' : 'ies'} by an unexpected author (${strangeAuthors.map((e) => JSON.stringify(e.by)).join(', ')})`);

    if (sr.isSynthetic === true) {
      if (history.some((entry) => isRemovalEntry(entry) || isReplacementEntry(entry))) {
        reasons.push('still synthetic, yet its history records a removal or a real-rating replacement');
      }
      if (isFinalRating(sr)) {
        lists.becomesFinal.push({ ...summarize(task), basis: sr.finalizedAt ? 'finalizedAt' : 'history (admin edit)', ...editSummary(edits) });
      } else {
        stillEstimates += 1;
        const assigned = assignByTaskId.get(String(task._id));
        if (!assigned) reasons.push('no assignment ledger record');
        else if (assigned.next?.assumedPercent !== sr.assumedPercent || assigned.next?.performanceRating !== task.performanceRating) {
          reasons.push(
            `differs from its assignment (${assigned.next?.assumedPercent}% "${assigned.next?.performanceRating}") with no admin edit in its history — changed outside the app`
          );
        }
      }
    } else if (isRemovalEntry(last)) {
      if (edits.length) lists.editedThenRemoved.push({ ...summarize(task), removedAt: time(last.at), ...editSummary(edits) });
    } else if (isReplacementEntry(last)) {
      if (edits.length) lists.editedThenReplacedByReal.push({ ...summarize(task), replacedAt: time(last.at), ...editSummary(edits) });
    } else {
      reasons.push('switched off with no removal or real-rating entry last in its history — changed outside the app');
    }

    if (reasons.length) lists.ambiguous.push({ ...summarize(task), isSynthetic: sr.isSynthetic === true, reasons });
  });

  const taskById = new Map(tasks.map((task) => [String(task._id), task]));
  const taskByCode = new Map(tasks.map((task) => [task.codeNumber, task]));
  activityEvents.forEach((event) => {
    const task = (event.taskId && taskById.get(String(event.taskId))) || taskByCode.get(event.metadata?.taskCode);
    const at = new Date(event.at).getTime();
    const matches = task
      ? adminEditsOf(task.syntheticRating?.history || []).some(
          (entry) => entry.toPercent === event.metadata?.toPercent && Math.abs(new Date(entry.at).getTime() - at) <= ACTIVITY_MATCH_WINDOW_MS
        )
      : false;
    if (!matches) {
      lists.activityWithoutHistory.push({
        code: event.metadata?.taskCode ?? (task ? task.codeNumber : null),
        at: time(event.at),
        userId: event.user ? String(event.user) : null,
        change: `${event.metadata?.fromPercent ?? '-'}% → ${event.metadata?.toPercent ?? '-'}%`,
        why: task ? 'no admin edit with that percent near that time in the task history' : 'the task no longer carries a synthetic rating (or does not exist)',
      });
    }
  });

  Object.values(lists).forEach((list) => list.sort((a, b) => String(a.code).localeCompare(String(b.code))));
  return {
    lists,
    totals: {
      tasksWithSyntheticRating: tasks.filter((task) => task.syntheticRating).length,
      stillEstimates,
      becomesFinal: lists.becomesFinal.length,
      editedThenRemoved: lists.editedThenRemoved.length,
      editedThenReplacedByReal: lists.editedThenReplacedByReal.length,
      ambiguous: lists.ambiguous.length,
      activityWithoutHistory: lists.activityWithoutHistory.length,
      // The dashboard's "M میں سے N تخمینی" over all tasks, before and after the deploy.
      estimatedRatingsShownBefore: syntheticRatedBefore,
      estimatedRatingsShownAfter: syntheticRatedAfter,
    },
  };
}

module.exports = { classify, adminEditsOf, ACTIVITY_MATCH_WINDOW_MS };
