const mongoose = require('mongoose');
const Task = require('../models/Task');
const TaskUpdate = require('../models/TaskUpdate');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const { NOTIFICATION_TYPES } = require('../utils/notificationTypes');
const logger = require('../utils/logger');
const taskService = require('./task.service');
const notificationService = require('./notification.service');
const { taskLine } = require('./receipt.service');

// The approved wording of the notice that a completed task was reopened.
const REOPENED_TITLE = 'کام دوبارہ کھول دیا گیا';

function reopenedMessage(actorName, task) {
  return `${actorName} نے یہ کام دوبارہ کھول دیا ہے: ${taskLine(task)}`;
}

// An update below 100% reopened a completed task (task.service.js applyNewUpdateToTask): one notice
// (in-app + push, through the one notification-creation path) to each active assignee except the
// person who reopened it. Called once the update's transaction has committed; a failure is logged
// and never undoes or fails the update. Returns how many notices were sent.
async function notifyReopened(task, actor) {
  let sent = 0;
  try {
    const ids = [...new Set(task.assignees.map((assignee) => String(assignee._id || assignee)))].filter((id) => id !== String(actor.id));
    if (ids.length === 0) return 0;
    const active = new Set((await User.find({ _id: { $in: ids }, isActive: true }).select('_id')).map((user) => user.id));
    for (const id of ids.filter((candidate) => active.has(candidate))) {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential, like every other fan-out here
        await notificationService.createNotification({
          recipientUserId: id,
          type: NOTIFICATION_TYPES.TASK_REOPENED,
          title: REOPENED_TITLE,
          message: reopenedMessage(actor.name, task),
          taskId: task._id,
          createdBy: actor.id,
          source: actor.role === 'admin' ? 'admin' : 'system',
          metadata: { taskCodeNumber: task.codeNumber },
        });
        sent += 1;
      } catch (err) {
        logger.error(`Task reopened: notice for task ${task._id} to ${id} failed:`, err.message || err);
      }
    }
  } catch (err) {
    logger.error(`Task reopened: notices for task ${task._id} failed:`, err.message || err);
  }
  return sent;
}

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
  let reopened = false;

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

      await taskService.applyNewUpdateToTask(task, { completionPercent }, { session, actorId: requestingUser.id });
      reopened = Boolean(task.$locals.reopened);
    });
  } finally {
    await session.endSession();
  }

  // Re-fetch outside the (now-committed) transaction, populated, for the response shape.
  const [populatedUpdate, populatedTask] = await Promise.all([
    TaskUpdate.findById(createdUpdateId).populate('updatedBy', 'name role responsibility'),
    Task.findById(taskId).populate('assignees', 'name responsibility').populate('createdBy', 'name').populate({ path: 'receipts.user', select: 'name' }),
  ]);

  if (reopened) await notifyReopened(populatedTask, requestingUser);

  return { update: populatedUpdate, task: populatedTask, reopened };
}

module.exports = { listUpdates, createUpdate, REOPENED_TITLE, reopenedMessage };
