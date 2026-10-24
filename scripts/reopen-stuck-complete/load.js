// The read-only queries both CLIs plan from (scripts/stuck-complete-dry-run.js and
// scripts/reopen-stuck-complete.js): find-only, lean, nothing written.
const Task = require('../../src/models/Task');
const TaskUpdate = require('../../src/models/TaskUpdate');
const HistoricalImportRecord = require('../../src/models/HistoricalImportRecord');
const { buildPlan, LEDGER_ACTION } = require('./plan');

async function loadPlan(now = new Date()) {
  const tasks = await Task.find({ $or: [{ status: 'complete' }, { status: 'closed', completionPercent: { $lt: 100 } }] })
    .sort({ codeNumber: 1 })
    .lean();
  const ids = tasks.map((task) => task._id);
  const [updates, importRecords, ledgerRecords] = await Promise.all([
    TaskUpdate.find({ taskId: { $in: ids } }).select('taskId completionPercent createdAt').sort({ createdAt: 1, _id: 1 }).lean(),
    // The historical import's own task records carry no `action`; every later change does.
    HistoricalImportRecord.find({ kind: 'task', action: { $exists: false }, targetId: { $in: ids } }).select('targetId').lean(),
    HistoricalImportRecord.find({ action: LEDGER_ACTION }).select('targetId taskCode next').lean(),
  ]);

  const updatesByTaskId = new Map();
  updates.forEach((update) => {
    const key = String(update.taskId);
    if (!updatesByTaskId.has(key)) updatesByTaskId.set(key, []);
    updatesByTaskId.get(key).push(update);
  });
  const importedTaskIds = new Set(importRecords.map((record) => String(record.targetId)));

  return buildPlan({ tasks, updatesByTaskId, importedTaskIds, ledgerRecords, now });
}

module.exports = { loadPlan };
