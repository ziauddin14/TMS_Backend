// Decides which FINAL synthetic ratings (an admin's edit — src/utils/syntheticRating.js) get their
// band corrected under the late rule, and what exactly would be written — pure functions over
// already-loaded data, no database access (so the whole decision is unit-tested and a dry run can
// never write). scripts/fix-final-rating-late-downgrade.js loads the data and, only with --commit,
// hands this plan to commit.js.
//
// The rule (src/services/task.service.js computeFinalRating): a final rating's band is computed
// like a real rating with P (the percent the admin entered) — ONE level down when the task was
// completed late. Before this rule, every final band was stored as the plain band of P. So the only
// tasks planned are those that are final, completed (closed / complete), late, and still carry the
// plain band of P where the rule now gives a lower one. Anything else that does not match the rule
// is listed as an anomaly and never written; any anomaly makes the checks fail.
const { computeFinalRating, ratingForPercent } = require('../../src/services/task.service');
const { isFinalRating } = require('../../src/utils/syntheticRating');

const LEDGER_ACTION = 'final-rating-late-downgrade';
const LEDGER_ACTION_ROLLED_BACK = 'final-rating-late-downgrade-rolled-back';
const ledgerKeyFor = (code) => `${LEDGER_ACTION}:${code}`;
// The history entry this script adds to each corrected task. Its author is a string, so it is never
// counted as an admin edit: the task stays final, and stays final for the same reason as before.
const HISTORY_AUTHOR = 'system:script';
const HISTORY_NOTE = 'final rating band corrected with the late rule — completed late, one level down (fix-final-rating-late-downgrade)';

const COMPLETED = ['closed', 'complete'];

function summarize(task) {
  return {
    taskId: String(task._id),
    code: task.codeNumber,
    title: task.title,
    status: task.status,
    completionPercent: task.completionPercent,
    assumedPercent: task.syntheticRating?.assumedPercent ?? null,
    performanceRating: task.performanceRating ?? null,
    timeStatus: task.timeStatus ? { type: task.timeStatus.type, days: task.timeStatus.days } : null,
  };
}

// tasks          — every Task that has a syntheticRating (lean)
// ledgerRecords  — this script's ACTIVE ledger records (action 'final-rating-late-downgrade')
// assignRecords  — the synthetic-ratings script's assignment records (for the personKey)
function buildPlan({ tasks, ledgerRecords = [], assignRecords = [] }) {
  const ledgerByTaskId = new Map(ledgerRecords.map((r) => [String(r.targetId), r]));
  const personKeyByTaskId = new Map(assignRecords.map((r) => [String(r.targetId), r.personKey]));
  const items = [];
  const alreadyCorrect = [];
  const alreadyFixed = [];
  const openFinals = [];
  const anomalies = [];

  tasks.forEach((task) => {
    if (!isFinalRating(task.syntheticRating)) return;
    const percent = task.syntheticRating.assumedPercent;
    const plain = ratingForPercent(percent);
    const expected = computeFinalRating(percent, task);
    const record = ledgerByTaskId.get(String(task._id));
    const row = { ...summarize(task), expected };

    if (record) {
      if (task.performanceRating === record.next?.performanceRating) alreadyFixed.push(row);
      else anomalies.push(`${task.codeNumber}: was corrected by an earlier run ("${record.next?.performanceRating}") but its band is now "${task.performanceRating}"`);
      return;
    }
    if (!COMPLETED.includes(task.status)) {
      // Open: no late downgrade while it is open (the app computes it again when it completes).
      openFinals.push(row);
      if (task.performanceRating !== plain) anomalies.push(`${task.codeNumber}: open, but its band "${task.performanceRating}" is not the plain band of ${percent}% ("${plain}")`);
      return;
    }
    if (task.performanceRating === expected) {
      alreadyCorrect.push(row);
      return;
    }
    if (task.timeStatus?.type === 'late' && task.performanceRating === plain) {
      items.push({ ...row, from: plain, to: expected, daysLate: task.timeStatus.days, personKey: personKeyByTaskId.get(String(task._id)) || 'app:final-rating' });
      return;
    }
    anomalies.push(
      `${task.codeNumber}: band "${task.performanceRating}" is neither the plain band of ${percent}% ("${plain}") nor the late-rule band ("${expected}") — left alone`
    );
  });

  const byChange = items.reduce((acc, i) => ({ ...acc, [`${i.from}→${i.to}`]: (acc[`${i.from}→${i.to}`] || 0) + 1 }), {});
  const checks = [
    {
      label: 'every planned task is final, completed late, and still carries the plain band of its percent',
      ok: items.every((i) => COMPLETED.includes(i.status) && i.timeStatus?.type === 'late' && i.performanceRating === i.from && i.from !== i.to),
      detail: `${items.length} planned`,
    },
    { label: 'no final rating that fits neither the old nor the new rule', ok: anomalies.length === 0, detail: anomalies.length ? anomalies.join('; ') : 'none' },
  ];

  return {
    items,
    alreadyCorrect,
    alreadyFixed,
    openFinals,
    anomalies,
    byChange,
    checks,
    ok: checks.every((c) => c.ok),
    totals: {
      finalRatings: items.length + alreadyCorrect.length + alreadyFixed.length + openFinals.length + anomalies.length,
      toFix: items.length,
      alreadyCorrect: alreadyCorrect.length,
      alreadyFixed: alreadyFixed.length,
      openFinals: openFinals.length,
      anomalies: anomalies.length,
    },
  };
}

module.exports = { buildPlan, ledgerKeyFor, LEDGER_ACTION, LEDGER_ACTION_ROLLED_BACK, HISTORY_AUTHOR, HISTORY_NOTE, COMPLETED };
