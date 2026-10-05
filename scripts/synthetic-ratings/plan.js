// Decides which tasks get a developer-assigned ("synthetic") rating and what exactly would be
// written — pure functions over already-loaded data, no database access (so the whole decision is
// unit-testable and a dry run can never write). scripts/assign-synthetic-ratings.js loads the data
// and, only with --commit, hands this plan to commit.js.
const { ratingForPercent } = require('../../src/services/task.service');

const LEDGER_ACTION = 'synthetic-rating';
const LEDGER_ACTION_ROLLED_BACK = 'synthetic-rating-rolled-back';
const ledgerKeyFor = (code) => `${LEDGER_ACTION}:${code}`;

// A task is "unrated" when it has no real rating: the stored '-' (or the field missing entirely).
function isUnrated(task) {
  return task.performanceRating === undefined || task.performanceRating === null || task.performanceRating === '-';
}

function isSynthetic(task) {
  return task.syntheticRating?.isSynthetic === true;
}

function summarize(task) {
  return {
    code: task.codeNumber,
    title: task.title,
    status: task.status,
    performanceRating: task.performanceRating ?? null,
    completionPercent: task.completionPercent,
  };
}

// tasks          — every Task (lean)
// importRecords  — the historical import's own ledger records (kind 'task')
// ratingRecords  — this script's ACTIVE ledger records (action 'synthetic-rating')
// config.groups  — [{ key, label, status, assumedPercent, expectedCount }]
// config.excludedCodes — { code: reason }: tasks that must STAY unrated ('-'), each for a recorded
//                  reason. Never planned; the plan fails its checks unless each one is present and
//                  still unrated.
function buildPlan({ tasks, importRecords, ratingRecords, config, now }) {
  const importByTaskId = new Map(importRecords.map((r) => [String(r.targetId), r]));
  const ratingByTaskId = new Map(ratingRecords.map((r) => [String(r.targetId), r]));
  const taskById = new Map(tasks.map((t) => [String(t._id), t]));
  const groupByStatus = new Map(config.groups.map((g) => [g.status, g]));
  const neverTouch = new Set(config.neverTouchCodes);
  const excludedCodes = config.excludedCodes || {};

  const groups = Object.fromEntries(
    config.groups.map((g) => [g.key, { ...g, rating: ratingForPercent(g.assumedPercent), toAssign: [], alreadySynthetic: [], replacedByReal: [] }])
  );
  const neverTouched = [];
  const excluded = [];
  const realRated = [];
  const notEligible = [];
  const anomalies = [];

  tasks.forEach((task) => {
    const id = String(task._id);
    const importRecord = importByTaskId.get(id);
    const ratingRecord = ratingByTaskId.get(id);

    if (neverTouch.has(task.codeNumber)) {
      neverTouched.push(summarize(task));
      if (ratingRecord || isSynthetic(task)) anomalies.push(`${task.codeNumber}: is on the never-touch list but carries a synthetic rating`);
      return;
    }
    if (excludedCodes[task.codeNumber]) {
      excluded.push({ ...summarize(task), why: excludedCodes[task.codeNumber], staysUnrated: isUnrated(task) && !isSynthetic(task) && !ratingRecord });
      return;
    }

    if (isSynthetic(task)) {
      const group = ratingRecord ? groups[ratingRecord.next?.group] : null;
      if (group) group.alreadySynthetic.push(summarize(task));
      else anomalies.push(`${task.codeNumber}: carries a synthetic rating but has no matching ledger record`);
      return;
    }
    if (ratingRecord) {
      // Given a synthetic rating by an earlier run, which the app has since replaced with a REAL
      // one (the task was closed or completed — task.service.js applyComputedRating switches the
      // marker off and keeps the subdocument as a record). Handled: counts towards its group, is
      // never planned again, and is not one of the import's own really-rated tasks.
      const group = groups[ratingRecord.next?.group];
      if (group && task.syntheticRating && task.syntheticRating.isSynthetic === false) group.replacedByReal.push(summarize(task));
      else anomalies.push(`${task.codeNumber}: has an active synthetic-rating ledger record but the task carries no synthetic rating`);
      return;
    }

    if (!isUnrated(task)) {
      realRated.push(summarize(task));
      return;
    }
    // Unrated from here on. Only tasks the historical import created are in scope: a task created
    // in the live app gets its rating the normal way, never a synthetic one.
    if (!importRecord) {
      notEligible.push({ ...summarize(task), why: 'not created by the historical import' });
      return;
    }
    const group = groupByStatus.get(task.status);
    if (!group) {
      notEligible.push({ ...summarize(task), why: `status "${task.status}" is not one of the target groups` });
      return;
    }

    const rating = ratingForPercent(group.assumedPercent);
    const previousRating = task.performanceRating ?? null;
    groups[group.key].toAssign.push({
      taskId: id,
      ...summarize(task),
      group: group.key,
      personKey: importRecord.personKey,
      assumedPercent: group.assumedPercent,
      newRating: rating,
      importFlags: {
        ratingBasis: importRecord.flags?.ratingBasis ?? null,
        handoverDecision: importRecord.flags?.handover?.decision ?? null,
      },
      // Exactly what commit.js $sets on the task — nothing else is written to it.
      syntheticRating: {
        isSynthetic: true,
        assumedPercent: group.assumedPercent,
        assignedAt: now,
        assignedBy: config.assignedBy,
        reason: config.reason,
        history: [
          {
            at: now,
            by: config.assignedBy,
            fromPercent: null,
            toPercent: group.assumedPercent,
            fromRating: previousRating,
            toRating: rating,
            note: `initial synthetic rating (${group.label})`,
          },
        ],
      },
    });
  });

  ratingRecords.forEach((record) => {
    if (!taskById.has(String(record.targetId))) anomalies.push(`${record.taskCode}: ledger record points at a task that no longer exists`);
  });

  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok, detail });

  Object.values(groups).forEach((g) => {
    const found = g.toAssign.length + g.alreadySynthetic.length + g.replacedByReal.length;
    const replaced = g.replacedByReal.length ? `, ${g.replacedByReal.length} since replaced by a real rating` : '';
    check(
      `${g.label}: exactly ${g.expectedCount} task(s)`,
      found === g.expectedCount,
      `found ${found} (${g.toAssign.length} to assign, ${g.alreadySynthetic.length} already synthetic${replaced})`
    );
  });
  check(
    `really-rated tasks left alone: exactly ${config.expectedRealRated}`,
    realRated.length === config.expectedRealRated,
    `found ${realRated.length}`
  );
  config.neverTouchCodes.forEach((code) => {
    const found = neverTouched.find((t) => t.code === code);
    check(`never-touch task ${code} is excluded`, true, found ? `present (status ${found.status}, rating ${found.performanceRating}) — not in the plan` : 'not in the database');
  });
  Object.keys(excludedCodes).forEach((code) => {
    const found = excluded.find((t) => t.code === code);
    let detail = 'NOT FOUND in the database';
    if (found) detail = found.staysUnrated ? `present, rating ${found.performanceRating ?? '(unset)'} — not in the plan` : `present but no longer unrated (rating ${found.performanceRating})`;
    check(`excluded task ${code} stays unrated`, Boolean(found && found.staysUnrated), detail);
  });
  check('no inconsistencies between tasks and the ledger', anomalies.length === 0, anomalies.length ? anomalies.join('; ') : 'none');

  const items = Object.values(groups).flatMap((g) => g.toAssign);
  // A rating the earlier import review deliberately withheld (a task closed as a handover). Every
  // such task is expected to be on the exclusion list, so finding one in the plan fails the checks.
  const reviewNotes = items
    .filter((i) => i.importFlags.handoverDecision === 'reassigned' || i.importFlags.ratingBasis === 'handover_reassigned')
    .map((i) => ({ code: i.code, title: i.title, group: i.group, note: 'closed as a handover ("reassigned") — the import review chose to leave this one unrated' }));
  check(
    'no task the import review left unrated as a handover is in the plan',
    reviewNotes.length === 0,
    reviewNotes.length ? `in the plan: ${reviewNotes.map((n) => n.code).join(', ')}` : 'none'
  );

  return {
    groups,
    items,
    neverTouched,
    excluded,
    realRated,
    notEligible,
    anomalies,
    reviewNotes,
    checks,
    ok: checks.every((c) => c.ok),
    totals: {
      tasks: tasks.length,
      toAssign: items.length,
      alreadySynthetic: Object.values(groups).reduce((n, g) => n + g.alreadySynthetic.length, 0),
      replacedByReal: Object.values(groups).reduce((n, g) => n + g.replacedByReal.length, 0),
    },
  };
}

module.exports = { buildPlan, isUnrated, isSynthetic, ledgerKeyFor, LEDGER_ACTION, LEDGER_ACTION_ROLLED_BACK };
