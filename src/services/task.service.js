const mongoose = require('mongoose');
const Task = require('../models/Task');
const User = require('../models/User');
const LookupList = require('../models/LookupList');
const Counter = require('../models/Counter');
const AppError = require('../utils/AppError');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PERFORMANCE_ORDER = ['excellent', 'good', 'fair', 'weak'];

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Whole-calendar-day difference (deadline minus referenceDate), ignoring time-of-day — required
// for the documented boundary case "deadline exactly today -> remaining, days:0", which would
// otherwise flip to overdue depending on what time of day "now" happens to be.
function daysBetween(deadline, referenceDate) {
  return Math.round((startOfDay(deadline) - startOfDay(referenceDate)) / MS_PER_DAY);
}

function downgradeOneLevel(rating) {
  const idx = PERFORMANCE_ORDER.indexOf(rating);
  return PERFORMANCE_ORDER[Math.min(idx + 1, PERFORMANCE_ORDER.length - 1)];
}

// Pure functions, no DB access (docs/06-backend.md §4.4, docs/02-db-design.md §7 — corrected
// versions: closeTask DOES recompute both fields, and the closed/complete reference date falls
// back through lastUpdateAt ?? closedAt ?? updatedAt).
function computeTimeStatus(task, now = new Date()) {
  if (task.status === 'ongoing' || task.status === 'pending') {
    const diffDays = daysBetween(task.deadline, now);
    return diffDays >= 0
      ? { type: 'remaining', days: diffDays }
      : { type: 'overdue', days: Math.abs(diffDays) };
  }
  if (task.status === 'complete' || task.status === 'closed') {
    const referenceDate = task.lastUpdateAt ?? task.closedAt ?? task.updatedAt;
    const diffDays = daysBetween(task.deadline, referenceDate);
    return diffDays >= 0
      ? { type: 'early', days: diffDays }
      : { type: 'late', days: Math.abs(diffDays) };
  }
  return { type: 'remaining', days: 0 };
}

function computePerformanceRating(completionPercent, timeStatus, status) {
  if (!['complete', 'closed'].includes(status)) return '-';
  let rating = completionPercent >= 90 ? 'excellent' : completionPercent >= 80 ? 'good' : completionPercent >= 70 ? 'fair' : 'weak'; // eslint-disable-line no-nested-ternary
  if (timeStatus.type === 'late') rating = downgradeOneLevel(rating);
  return rating;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// docs/06-backend.md §4.2 step 1: every id must exist AND be isActive:true, or the whole
// operation is rejected with the invalid/inactive ids listed — never a silent drop. Malformed
// (non-ObjectId) ids are pre-filtered rather than sent into the $in query, which would otherwise
// throw a CastError instead of a clean VALIDATION_ERROR.
async function validateAssignees(assigneeIds) {
  const uniqueIds = [...new Set(assigneeIds.map(String))];
  const wellFormedIds = uniqueIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
  const malformedIds = uniqueIds.filter((id) => !mongoose.Types.ObjectId.isValid(id));

  const found = wellFormedIds.length
    ? await User.find({ _id: { $in: wellFormedIds }, isActive: true }).select('_id')
    : [];
  const foundIds = new Set(found.map((u) => u.id));
  const invalidIds = [...malformedIds, ...wellFormedIds.filter((id) => !foundIds.has(id))];

  if (invalidIds.length > 0) {
    throw new AppError('One or more assignees are invalid or inactive.', 400, 'VALIDATION_ERROR', [
      { field: 'assignees', message: `Invalid or inactive user id(s): ${invalidIds.join(', ')}` },
    ]);
  }
}

// Service-layer check (not a schema foreign key, per docs/04-db-models.md §5's "kept as plain
// text so historical tasks are unaffected if a value is later retired") that responsibility
// matches a currently-active lookupLists entry, so a typo can never enter the system at
// creation/edit time — explicitly required by the Phase 5 instructions.
async function validateResponsibility(responsibility) {
  const entry = await LookupList.findOne({
    listType: 'responsibility',
    value: responsibility,
    isActive: true,
  });
  if (!entry) {
    throw new AppError('Unrecognized responsibility value.', 400, 'VALIDATION_ERROR', [
      {
        field: 'responsibility',
        message: `"${responsibility}" is not a recognized active responsibility value.`,
      },
    ]);
  }
}

function buildTaskFilter(requestingUser, filters) {
  const {
    status,
    performanceRating,
    assigneeId,
    responsibility,
    deadlineFrom,
    deadlineTo,
    entryFrom,
    entryTo,
    search,
  } = filters;

  const filter = {};
  if (status) filter.status = status;
  if (performanceRating) filter.performanceRating = performanceRating;
  if (responsibility) filter.responsibility = responsibility;

  if (deadlineFrom || deadlineTo) {
    filter.deadline = {};
    if (deadlineFrom) filter.deadline.$gte = deadlineFrom;
    if (deadlineTo) filter.deadline.$lte = deadlineTo;
  }
  if (entryFrom || entryTo) {
    filter.createdAt = {};
    if (entryFrom) filter.createdAt.$gte = entryFrom;
    if (entryTo) filter.createdAt.$lte = entryTo;
  }
  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ title: regex }, { codeNumber: regex }];
  }

  // Ownership scoping (docs/05-apis.md §5): forced here in the service, never trusted from the
  // controller/query string — a User can never see another user's tasks by manipulating assigneeId.
  if (requestingUser.role === 'user') {
    filter.assignees = requestingUser.id;
  } else if (assigneeId) {
    filter.assignees = assigneeId;
  }

  return filter;
}

async function listTasks(requestingUser, filters, pagination) {
  const filter = buildTaskFilter(requestingUser, filters);
  const { page, limit, sortBy = 'deadline', sortOrder = 'asc' } = pagination;
  const skip = (page - 1) * limit;
  const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

  const [items, total] = await Promise.all([
    Task.find(filter)
      .populate('assignees', 'name responsibility')
      .populate('createdBy', 'name')
      .sort(sort)
      .skip(skip)
      .limit(limit),
    Task.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

async function getTaskById(requestingUser, taskId) {
  if (!mongoose.Types.ObjectId.isValid(taskId)) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }

  const task = await Task.findById(taskId).populate('assignees', 'name responsibility').populate('createdBy', 'name');
  if (!task) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }

  if (requestingUser.role !== 'admin') {
    const isAssignee = task.assignees.some((assignee) => assignee.id === requestingUser.id);
    if (!isAssignee) {
      throw new AppError('You are not assigned to this task.', 403, 'FORBIDDEN_NOT_ASSIGNEE');
    }
  }

  return task;
}

// docs/06-backend.md §4.2
async function createTask(adminUser, { title, assignees, responsibility, deadline }) {
  await validateAssignees(assignees);
  await validateResponsibility(responsibility);

  const codeNumber = await Counter.getNextCodeNumber();

  const taskData = {
    codeNumber,
    title,
    assignees,
    responsibility,
    deadline,
    status: 'ongoing',
    completionPercent: 0,
    createdBy: adminUser.id,
  };
  taskData.timeStatus = computeTimeStatus(taskData);

  const created = await Task.create(taskData);
  return Task.findById(created._id).populate('assignees', 'name responsibility').populate('createdBy', 'name');
}

// docs/06-backend.md §4.3 — edits setup fields only, never status/completionPercent/
// performanceRating. Recomputes timeStatus immediately if deadline changed.
async function updateTaskFields(taskId, patch) {
  if (!mongoose.Types.ObjectId.isValid(taskId)) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }
  const task = await Task.findById(taskId);
  if (!task) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }

  // Correction (docs/06-backend.md §4.3, docs/05-apis.md PATCH /tasks/:id): a closed task is
  // fully read-only, not just update-proof — checked first, before any field validation, so no
  // partial/inconsistent state can ever result from editing something already terminal.
  if (task.status === 'closed') {
    throw new AppError('Yeh kaam close ho chuka hai', 400, 'VALIDATION_ERROR');
  }

  if (patch.assignees !== undefined) {
    await validateAssignees(patch.assignees);
    task.assignees = patch.assignees;
  }
  if (patch.responsibility !== undefined) {
    await validateResponsibility(patch.responsibility);
    task.responsibility = patch.responsibility;
  }
  if (patch.title !== undefined) {
    task.title = patch.title;
  }
  if (patch.deadline !== undefined) {
    task.deadline = patch.deadline;
    task.timeStatus = computeTimeStatus(task);
  }

  await task.save();
  return Task.findById(task._id).populate('assignees', 'name responsibility').populate('createdBy', 'name');
}

// docs/06-backend.md §4.3 (corrected): closing DOES recompute timeStatus and performanceRating,
// using the current completionPercent and the referenceDate fallback chain — a task closed while
// still short of 100% must still receive a real rating, never stay stuck at '-'.
async function closeTask(adminUser, taskId) {
  if (!mongoose.Types.ObjectId.isValid(taskId)) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }
  const task = await Task.findById(taskId);
  if (!task) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }

  task.status = 'closed';
  task.closedBy = adminUser.id;
  task.closedAt = new Date();
  task.timeStatus = computeTimeStatus(task);
  task.performanceRating = computePerformanceRating(task.completionPercent, task.timeStatus, task.status);

  await task.save();
  return Task.findById(task._id).populate('assignees', 'name responsibility').populate('createdBy', 'name');
}

// docs/06-backend.md §4.5 — Phase 6 addition. Called by taskUpdate.service.js's createUpdate,
// inside the same MongoDB transaction, immediately after a new TaskUpdate is created. Mutates and
// saves the given Task document; does not re-fetch/re-populate — that's the caller's job. Accepts
// an optional { session } so the save participates in the caller's transaction.
async function applyNewUpdateToTask(task, updatePayload, { session } = {}) {
  task.completionPercent = updatePayload.completionPercent;
  task.lastUpdateAt = new Date();
  if (task.completionPercent >= 100 && task.status !== 'closed') {
    task.status = 'complete';
  }
  task.timeStatus = computeTimeStatus(task);
  task.performanceRating = computePerformanceRating(task.completionPercent, task.timeStatus, task.status);
  await task.save({ session });
  return task;
}

module.exports = {
  listTasks,
  getTaskById,
  createTask,
  updateTaskFields,
  closeTask,
  computeTimeStatus,
  computePerformanceRating,
  applyNewUpdateToTask,
  // Phase 7 addition: exported (unchanged body) so dashboard.service.js can reuse the exact same
  // RBAC-scoping rule listTasks already uses, per docs/06-backend.md §4.1, instead of
  // reimplementing it. Calling buildTaskFilter(requestingUser, {}) yields exactly the scoping
  // clause (nothing else, since every other destructured filter field is undefined) — {} for
  // Admin, { assignees: requestingUser.id } for a User.
  buildTaskFilter,
};
