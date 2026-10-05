const taskService = require('../services/task.service');
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

// POST /tasks — Admin only
const createTask = asyncHandler(async (req, res) => {
  const task = await taskService.createTask(req.user, req.body);
  sendSuccess(res, { data: serializeTask(task, req.user), statusCode: 201 });
});

// PATCH /tasks/:id — Admin only
const updateTask = asyncHandler(async (req, res) => {
  const task = await taskService.updateTaskFields(req.params.id, req.body);
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

module.exports = { listTasks, getTask, createTask, updateTask, closeTask, editSyntheticRating, removeSyntheticRating };
