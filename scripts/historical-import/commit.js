// Writes a plan produced by plan.js. Only ever reached from the CLI's --commit path, after its
// own guards (backup taken, review decisions recorded) have passed.
//
// Safety model:
// - One MongoDB transaction per task: its Task, all of its TaskUpdates and every ledger record are
//   committed together or not at all, so a crash can never leave a task half-imported.
// - Idempotent: a task whose 'task:<code>' ledger record already exists is skipped entirely, so
//   re-running after a partial failure simply continues where it stopped.
// - A live Task already holding the same codeNumber WITHOUT a ledger record is never touched —
//   reported as a conflict instead.
// - timestamps:false — Mongoose would otherwise overwrite the historical createdAt/updatedAt
//   values with "now".
const mongoose = require('mongoose');
const Task = require('../../src/models/Task');
const TaskUpdate = require('../../src/models/TaskUpdate');
const HistoricalImportRecord = require('../../src/models/HistoricalImportRecord');

async function commitTask(planned, importBatch, session) {
  const [task] = await Task.create([planned.task], { session, timestamps: false });

  const updates = await TaskUpdate.create(
    planned.updates.map((u) => ({ ...u.update, taskId: task._id })),
    { session, timestamps: false, ordered: true }
  );

  const records = [
    {
      importBatch,
      sourceKey: planned.sourceKey,
      kind: 'task',
      targetId: task._id,
      taskCode: planned.code,
      personKey: planned.personKey,
      flags: {
        closureSignal: planned.closureSignal,
        ratingBasis: planned.ratingBasis,
        mergedFrom: planned.mergedFrom,
        handover: planned.handover,
        reviewNotes: planned.reviewNotes,
      },
      dataQualityIssues: planned.dataQualityIssues,
      raw: planned.raw,
    },
    ...planned.updates.map((u, i) => ({
      importBatch,
      sourceKey: u.sourceKey,
      kind: 'taskUpdate',
      targetId: updates[i]._id,
      taskCode: planned.code,
      personKey: planned.personKey,
      flags: { ...u.flags, dateSource: u.dateSource, percentSource: u.percentSource, percentsFound: u.percentsFound },
      dataQualityIssues: u.dataQualityIssues,
      raw: u.raw,
    })),
  ];
  await HistoricalImportRecord.create(records, { session, ordered: true });

  return updates.length;
}

async function commitPlan(plan, { importBatch, log = () => {} }) {
  const result = { tasksCreated: 0, updatesCreated: 0, tasksSkippedAlreadyImported: 0, conflicts: [] };

  for (const planned of plan.tasks) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design: one task per transaction
    if (await HistoricalImportRecord.exists({ sourceKey: planned.sourceKey })) {
      result.tasksSkippedAlreadyImported += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await Task.exists({ codeNumber: planned.code })) {
      result.conflicts.push({ code: planned.code, reason: 'a Task with this codeNumber already exists without an import record' });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const session = await mongoose.startSession();
    try {
      let created = 0;
      // eslint-disable-next-line no-await-in-loop
      await session.withTransaction(async () => {
        created = await commitTask(planned, importBatch, session);
      });
      result.tasksCreated += 1;
      result.updatesCreated += created;
      log(`imported ${planned.code} (${created} updates)`);
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await session.endSession();
    }
  }

  return result;
}

module.exports = { commitPlan };
