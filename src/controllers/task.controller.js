const taskService = require('../services/task.service');
const receiptService = require('../services/receipt.service');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');
const { serializeTask } = require('../serializers/task.serializer');

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
  sendSuccess(res, { data: serializeTask(task, req.user), statusCode: 201 });
});

// PATCH /tasks/:id — Admin only. Receipts follow an assignee change (receipt.service.js).
const updateTask = asyncHandler(async (req, res) => {
  const task = await taskService.updateTaskFields(req.params.id, req.body, { actor: req.user, withReceipts: true });
  sendSuccess(res, { data: serializeTask(task, req.user) });
});

// PATCH /tasks/:id/close — Admin only
const closeTask = asyncHandler(async (req, res) => {
  const task = await taskService.closeTask(req.user, req.params.id);
  sendSuccess(res, { data: serializeTask(task, req.user) });
});

// PATCH /tasks/:id/synthetic-rating — Admin only
const editSyntheticRating = asyncHandler(async (req, res) => {
  const task = await taskService.editSyntheticRating(req.user, req.params.id, req.body);
  sendSuccess(res, { data: serializeTask(task, req.user) });
});

// DELETE /tasks/:id/synthetic-rating — Admin only
const removeSyntheticRating = asyncHandler(async (req, res) => {
  const task = await taskService.removeSyntheticRating(req.user, req.params.id, req.body);
  sendSuccess(res, { data: serializeTask(task, req.user) });
});

// POST /tasks/:id/acknowledge — the signed-in person confirms their own receipt ("وصول کر لیا").
// Idempotent. Responds with the task as they may see it.
const acknowledgeTask = asyncHandler(async (req, res) => {
  await receiptService.acknowledge(req.user, req.params.id);
  const task = await taskService.getTaskById(req.user, req.params.id);
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
