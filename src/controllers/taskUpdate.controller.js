const taskUpdateService = require('../services/taskUpdate.service');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');
const { serializeTask } = require('../serializers/task.serializer');

function serializeUpdate(update) {
  return {
    id: update.id,
    taskId: update.taskId,
    updatedBy: update.updatedBy
      ? {
          id: update.updatedBy.id,
          name: update.updatedBy.name,
          role: update.updatedBy.role,
          responsibility: update.updatedBy.responsibility,
        }
      : null,
    description: update.description,
    completionPercent: update.completionPercent,
    attachment: update.attachment,
    createdAt: update.createdAt,
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
    // Same task representation as GET /tasks/:id (docs/05-apis.md §6 step 3) — the one shared
    // serializer, so the two can never drift apart.
    data: { update: serializeUpdate(update), task: serializeTask(task, req.user) },
    statusCode: 201,
  });
});

module.exports = { listUpdates, createUpdate };
