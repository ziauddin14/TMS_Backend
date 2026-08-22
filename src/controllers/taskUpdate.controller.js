const taskUpdateService = require('../services/taskUpdate.service');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

function serializeUpdate(update) {
  return {
    id: update.id,
    taskId: update.taskId,
    updatedBy: update.updatedBy
      ? { id: update.updatedBy.id, name: update.updatedBy.name, role: update.updatedBy.role }
      : null,
    description: update.description,
    completionPercent: update.completionPercent,
    attachment: update.attachment,
    createdAt: update.createdAt,
  };
}

// Same task representation as task.controller.js's GET /tasks/:id (docs/05-apis.md §6 step 3:
// "Success (201): { update, task: {...updated task...} }"). Kept as a small local copy rather
// than importing from task.controller.js, since that module doesn't export it and Phase 6 must
// not modify any Phase 5 file beyond the one documented task.service.js addition (see Phase 6
// report, section H).
function serializeTask(task) {
  return {
    id: task.id,
    codeNumber: task.codeNumber,
    title: task.title,
    assignees: task.assignees.map((a) => ({ id: a.id, name: a.name, responsibility: a.responsibility })),
    responsibility: task.responsibility,
    deadline: task.deadline,
    status: task.status,
    completionPercent: task.completionPercent,
    lastUpdateAt: task.lastUpdateAt,
    timeStatus: task.timeStatus,
    performanceRating: task.performanceRating,
    createdBy: task.createdBy ? { id: task.createdBy.id, name: task.createdBy.name } : null,
    closedBy: task.closedBy,
    closedAt: task.closedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

// GET /tasks/:id/updates
const listUpdates = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const { items, meta } = await taskUpdateService.listUpdates(req.user, req.params.id, { page, limit });
  sendSuccess(res, { data: items.map(serializeUpdate), meta });
});

// POST /tasks/:id/updates
const createUpdate = asyncHandler(async (req, res) => {
  const { update, task } = await taskUpdateService.createUpdate(req.user, req.params.id, req.body);
  sendSuccess(res, {
    data: { update: serializeUpdate(update), task: serializeTask(task) },
    statusCode: 201,
  });
});

module.exports = { listUpdates, createUpdate };
