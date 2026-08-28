const mongoose = require('mongoose');
const Task = require('../models/Task');
const TaskUpdate = require('../models/TaskUpdate');
const AppError = require('../utils/AppError');
const taskService = require('./task.service');

/**
 * Mirrors task.service.js's getTaskById ownership rule exactly (Admin, or assignee-membership;
 * same FORBIDDEN_NOT_ASSIGNEE message/code) — implemented locally rather than calling
 * getTaskById directly, because createUpdate must run this check against the SAME
 * session-bound, unpopulated task document already fetched inside its transaction.
 * getTaskById does its own separate, non-transactional, populated fetch, which would be
 * architecturally wrong to call mid-transaction here (see Phase 6 report, section H).
 */
function assertAssigneeOrAdmin(requestingUser, task) {
  if (requestingUser.role === 'admin') return;
  const isAssignee = task.assignees.some((assigneeId) => assigneeId.toString() === requestingUser.id);
  if (!isAssignee) {
    throw new AppError('You are not assigned to this task.', 403, 'FORBIDDEN_NOT_ASSIGNEE');
  }
}

// docs/06-backend.md §5 — reuses task.service.js's getTaskById exactly for the read path (no
// transaction/session involved here, so there's no reason not to call it directly).
async function listUpdates(requestingUser, taskId, pagination) {
  await taskService.getTaskById(requestingUser, taskId);

  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    TaskUpdate.find({ taskId }).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('updatedBy', 'name role responsibility'),
    TaskUpdate.countDocuments({ taskId }),
  ]);

  return { items, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

// docs/06-backend.md §5 — ownership check, closed-task rejection, then both writes inside one
// MongoDB transaction (session.withTransaction — the driver-recommended wrapper around
// startTransaction/commitTransaction/abortTransaction, which additionally retries genuine
// transient transaction errors while still propagating ordinary thrown errors, like our
// AppErrors, immediately without retrying them).
async function createUpdate(requestingUser, taskId, { description, completionPercent, attachment }) {
  if (!mongoose.Types.ObjectId.isValid(taskId)) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }

  const session = await mongoose.startSession();
  let createdUpdateId;

  try {
    await session.withTransaction(async () => {
      const task = await Task.findById(taskId).session(session);
      if (!task) {
        throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
      }

      assertAssigneeOrAdmin(requestingUser, task);

      // docs/06-backend.md §5 step 2 / docs/05-apis.md §6 — same rule and wording as the Phase 5
      // correction for PATCH /tasks/:id: a closed task is fully read-only.
      if (task.status === 'closed') {
        throw new AppError('Yeh kaam close ho chuka hai', 400, 'VALIDATION_ERROR');
      }

      const [created] = await TaskUpdate.create(
        [
          {
            taskId,
            updatedBy: requestingUser.id,
            description,
            completionPercent,
            attachment: attachment ?? null,
          },
        ],
        { session }
      );
      createdUpdateId = created._id;

      await taskService.applyNewUpdateToTask(task, { completionPercent }, { session });
    });
  } finally {
    await session.endSession();
  }

  // Re-fetch outside the (now-committed) transaction, populated, for the response shape.
  const [populatedUpdate, populatedTask] = await Promise.all([
    TaskUpdate.findById(createdUpdateId).populate('updatedBy', 'name role responsibility'),
    Task.findById(taskId).populate('assignees', 'name responsibility').populate('createdBy', 'name'),
  ]);

  return { update: populatedUpdate, task: populatedTask };
}

module.exports = { listUpdates, createUpdate };
