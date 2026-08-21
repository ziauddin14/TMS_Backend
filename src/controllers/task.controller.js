const taskService = require('../services/task.service');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

function serializeAssignee(user) {
  return { id: user.id, name: user.name, responsibility: user.responsibility };
}

// docs/05-apis.md §5 — each task populated with assignees (name, responsibility) and createdBy (name).
function serializeTask(task) {
  return {
    id: task.id,
    codeNumber: task.codeNumber,
    title: task.title,
    assignees: task.assignees.map(serializeAssignee),
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

// GET /tasks — scoping enforced in task.service.js
const listTasks = asyncHandler(async (req, res) => {
  const { page, limit, sortBy, sortOrder, ...filters } = req.query;
  const { items, meta } = await taskService.listTasks(req.user, filters, { page, limit, sortBy, sortOrder });
  sendSuccess(res, { data: items.map(serializeTask), meta });
});

// GET /tasks/:id — Admin or assignee-membership, enforced in task.service.js
const getTask = asyncHandler(async (req, res) => {
  const task = await taskService.getTaskById(req.user, req.params.id);
  sendSuccess(res, { data: serializeTask(task) });
});

// POST /tasks — Admin only
const createTask = asyncHandler(async (req, res) => {
  const task = await taskService.createTask(req.user, req.body);
  sendSuccess(res, { data: serializeTask(task), statusCode: 201 });
});

// PATCH /tasks/:id — Admin only
const updateTask = asyncHandler(async (req, res) => {
  const task = await taskService.updateTaskFields(req.params.id, req.body);
  sendSuccess(res, { data: serializeTask(task) });
});

// PATCH /tasks/:id/close — Admin only
const closeTask = asyncHandler(async (req, res) => {
  const task = await taskService.closeTask(req.user, req.params.id);
  sendSuccess(res, { data: serializeTask(task) });
});

module.exports = { listTasks, getTask, createTask, updateTask, closeTask };
