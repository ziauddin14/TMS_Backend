const taskService = require('../services/task.service');
const receiptService = require('../services/receipt.service');
const activityService = require('../services/activity.service');
const { ACTIVITY_TYPES } = require('../utils/activityTypes');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');
const { serializeTask } = require('../serializers/task.serializer');

// Activity log: each action below is recorded for the signed-in person AFTER it succeeded, fire-
// and-forget (services/activity.service.js) — the log can never fail or slow the action itself.

// GET /tasks — scoping enforced in task.service.js
const listTasks = asyncHandler(async (req, res) => {
  const { page, limit, sortBy, sortOrder, ...filters } = req.query;
  const { items, meta } = await taskService.listTasks(req.user, filters, { page, limit, sortBy, sortOrder });
  sendSuccess(res, { data: items.map((task) => serializeTask(task, req.user)), meta });
});

// GET /tasks/:id — Admin or assignee-membership, enforced in task.service.js
const getTask = asyncHandler(async (req, res) => {
  const task = await taskService.getTaskById(req.user, req.params.id);
  sendSuccess(res, { data: serializeTask(task, req.user) });
});

// POST /tasks — Admin only. The one path that opts a new task into task receipts: each eligible
// assignee gets a receipt and the assignment notice (receipt.service.js).
const createTask = asyncHandler(async (req, res) => {
  const task = await taskService.createTask(req.user, req.body, { withReceipts: true });
  activityService.record(req, ACTIVITY_TYPES.TASK_CREATED, {
    taskId: task._id,
    metadata: { taskCode: task.codeNumber, assignees: task.assignees.length },
  });
  sendSuccess(res, { data: serializeTask(task, req.user), statusCode: 201 });
});

// PATCH /tasks/:id — Admin only. Receipts follow an assignee change (receipt.service.js). For the
// log, what really changed (task.service.js's $locals.changes): other fields → "edited" with their
// NAMES; the assignees → "reassigned" with who was added / taken off. Nothing changed, no event.
const updateTask = asyncHandler(async (req, res) => {
  const task = await taskService.updateTaskFields(req.params.id, req.body, { actor: req.user, withReceipts: true });
  const changes = task.$locals.changes || { fields: [], addedAssignees: [], removedAssignees: [] };
  if (changes.fields.length > 0) {
    activityService.record(req, ACTIVITY_TYPES.TASK_EDITED, { taskId: task._id, metadata: { taskCode: task.codeNumber, fields: changes.fields } });
  }
  if (changes.addedAssignees.length > 0 || changes.removedAssignees.length > 0) {
    activityService.record(req, ACTIVITY_TYPES.TASK_REASSIGNED, {
      taskId: task._id,
      metadata: { taskCode: task.codeNumber, addedUserIds: changes.addedAssignees, removedUserIds: changes.removedAssignees },
    });
  }
  sendSuccess(res, { data: serializeTask(task, req.user) });
});

// PATCH /tasks/:id/close — Admin only
const closeTask = asyncHandler(async (req, res) => {
  const task = await taskService.closeTask(req.user, req.params.id);
  activityService.record(req, ACTIVITY_TYPES.TASK_CLOSED, { taskId: task._id, metadata: { taskCode: task.codeNumber } });
  sendSuccess(res, { data: serializeTask(task, req.user) });
});

function lastSyntheticChange(task) {
  const history = task.syntheticRating?.history || [];
  return history[history.length - 1] || {};
}

// PATCH /tasks/:id/synthetic-rating — Admin only
const editSyntheticRating = asyncHandler(async (req, res) => {
  const task = await taskService.editSyntheticRating(req.user, req.params.id, req.body);
  const change = lastSyntheticChange(task);
  activityService.record(req, ACTIVITY_TYPES.SYNTHETIC_RATING_EDITED, {
    taskId: task._id,
    metadata: { taskCode: task.codeNumber, fromPercent: change.fromPercent ?? null, toPercent: change.toPercent ?? null },
  });
  sendSuccess(res, { data: serializeTask(task, req.user) });
});

// DELETE /tasks/:id/synthetic-rating — Admin only
const removeSyntheticRating = asyncHandler(async (req, res) => {
  const task = await taskService.removeSyntheticRating(req.user, req.params.id, req.body);
  activityService.record(req, ACTIVITY_TYPES.SYNTHETIC_RATING_REMOVED, {
    taskId: task._id,
    metadata: { taskCode: task.codeNumber, fromPercent: lastSyntheticChange(task).fromPercent ?? null },
  });
  sendSuccess(res, { data: serializeTask(task, req.user) });
});

// POST /tasks/:id/acknowledge — the signed-in person confirms their own receipt ("وصول کر لیا").
// Idempotent; logged only the first time (when it actually confirmed something). Responds with the
// task as they may see it.
const acknowledgeTask = asyncHandler(async (req, res) => {
  const confirmed = await receiptService.acknowledge(req.user, req.params.id);
  const task = await taskService.getTaskById(req.user, req.params.id);
  if (confirmed) {
    activityService.record(req, ACTIVITY_TYPES.TASK_RECEIPT_CONFIRMED, { taskId: task._id, metadata: { taskCode: task.codeNumber } });
  }
  sendSuccess(res, { data: serializeTask(task, req.user) });
});

module.exports = {
  listTasks,
  getTask,
  createTask,
  updateTask,
  closeTask,
  editSyntheticRating,
  removeSyntheticRating,
  acknowledgeTask,
};
