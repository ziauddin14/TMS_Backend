const mongoose = require('mongoose');
const Task = require('../models/Task');
const User = require('../models/User');
const Counter = require('../models/Counter');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PERFORMANCE_ORDER = ['excellent', 'good', 'fair', 'weak'];
const KARACHI_TIME_ZONE = 'Asia/Karachi';

// Phase 9's original `date.setHours(0, 0, 0, 0)` anchored the business day to the HOST PROCESS's
// own local timezone — correct only by coincidence when the host happens to run in Asia/Karachi
// (true of this dev machine, not guaranteed of a production container, e.g. Render's default
// UTC). The application's business calendar is Pakistan time (Phase 3's Karachi-timezone
// requirement), so the day boundary must be computed from Asia/Karachi regardless of
// process.env.TZ — Intl.DateTimeFormat with an explicit timeZone is TZ-independent of the host.
const karachiDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: KARACHI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function getKarachiDateParts(date) {
  const byType = {};
  karachiDateFormatter.formatToParts(date).forEach((part) => {
    if (part.type !== 'literal') byType[part.type] = part.value;
  });
  return { year: Number(byType.year), month: Number(byType.month), day: Number(byType.day) };
}

// Returns a fixed UTC-midnight instant representing the Karachi calendar date of `date` — not
// Karachi midnight itself, deliberately: daysBetween() below only needs two dates on the same
// Karachi calendar day to produce an identical instant, and two dates on adjacent Karachi
// calendar days to differ by exactly one MS_PER_DAY. A constant UTC-anchored representation per
// calendar date guarantees both, with no DST edge case (Asia/Karachi has had no DST since 2002).
function startOfDay(date) {
  const { year, month, day } = getKarachiDateParts(date);
  return new Date(Date.UTC(year, month - 1, day));
}

// The Pakistan calendar-date string (YYYY-MM-DD) — used by Phase 3's automatic reminder engine to
// build its dedupKey ("today" must always mean Karachi's today, never the host's).
function getPakistanDateString(date = new Date()) {
  const { year, month, day } = getKarachiDateParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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

// The percentage thresholds alone — no status rule, no late downgrade. The one definition of them:
// computePerformanceRating below builds the real rating on top of it, and a developer-assigned
// (synthetic) rating (models/Task.js syntheticRating) is exactly this value for its assumedPercent.
function ratingForPercent(percent) {
  return percent >= 90 ? 'excellent' : percent >= 80 ? 'good' : percent >= 70 ? 'fair' : 'weak'; // eslint-disable-line no-nested-ternary
}

function computePerformanceRating(completionPercent, timeStatus, status) {
  if (!['complete', 'closed'].includes(status)) return '-';
  let rating = ratingForPercent(completionPercent);
  if (timeStatus.type === 'late') rating = downgradeOneLevel(rating);
  return rating;
}

// Sets task.performanceRating from the real formula — the one place closeTask and
// applyNewUpdateToTask do it — with one rule on top for a task that carries a developer-assigned
// (synthetic) rating (models/Task.js syntheticRating):
//
// - While the formula has nothing real to give (the task is still ongoing/pending, so it returns
//   '-'), the synthetic rating stays in force: performanceRating and syntheticRating are left
//   exactly as they are. An update on an open task must not reset a synthetic rating to '-'.
// - The moment the formula yields a REAL rating (the task is closed, or an update takes it to
//   complete), that real rating replaces the synthetic one: performanceRating is overwritten,
//   syntheticRating.isSynthetic becomes false, and the replacement is recorded in its history.
//   The rest of syntheticRating is kept as the record of what was once assumed.
//
// A task with no synthetic rating (or one already retired) gets the formula's value, as always.
function applyComputedRating(task, { actorId, note, now = new Date() }) {
  const realRating = computePerformanceRating(task.completionPercent, task.timeStatus, task.status);

  if (task.syntheticRating?.isSynthetic !== true) {
    task.performanceRating = realRating;
    return;
  }
  if (realRating === '-') return;

  task.syntheticRating.history.push({
    at: now,
    by: mongoose.Types.ObjectId.isValid(actorId) ? new mongoose.Types.ObjectId(actorId) : 'system',
    fromPercent: task.syntheticRating.assumedPercent,
    toPercent: task.completionPercent,
    fromRating: task.performanceRating,
    toRating: realRating,
    note,
  });
  task.syntheticRating.isSynthetic = false;
  task.performanceRating = realRating;
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

function buildTaskFilter(requestingUser, filters) {
  const {
    status,
    performanceRating,
    ratingSource,
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

  // Where a rating came from: a developer-assigned (synthetic) one, or a real one — i.e. rated
  // AND not synthetic. Written as its own clause so it simply combines with a performanceRating
  // filter (a real rating that is also "-" correctly matches nothing).
  if (ratingSource === 'synthetic') {
    filter['syntheticRating.isSynthetic'] = true;
  } else if (ratingSource === 'real') {
    filter['syntheticRating.isSynthetic'] = { $ne: true };
    filter.$and = [{ performanceRating: { $ne: '-' } }];
  }

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
  applyComputedRating(task, { actorId: adminUser.id, note: 'synthetic rating replaced by the real rating — task closed' });

  await task.save();
  return Task.findById(task._id).populate('assignees', 'name responsibility').populate('createdBy', 'name');
}

// ---- Admin edits of a developer-assigned (synthetic) rating --------------------------------
// Both write with one targeted update — exactly performanceRating, the named syntheticRating
// fields and one new history entry — and with timestamps:false, so nothing else on the task can
// move: not status, completionPercent, lastUpdateAt, timeStatus or updatedAt. No TaskUpdate is
// created and no notification is sent. The history entry (who, when, from → to, note) is the audit
// trail; a log line records it server-side as well.
async function findTaskWithSyntheticRating(taskId) {
  if (!mongoose.Types.ObjectId.isValid(taskId)) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }
  const task = await Task.findById(taskId);
  if (!task) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }
  if (task.syntheticRating?.isSynthetic !== true) {
    throw new AppError('This task does not have a synthetic rating.', 409, 'NOT_SYNTHETIC_RATING');
  }
  return task;
}

async function writeSyntheticRatingChange(task, adminUser, { set, historyEntry }) {
  const result = await Task.updateOne(
    // Still synthetic at the moment of writing — a real close in between must win, not be overwritten.
    { _id: task._id, 'syntheticRating.isSynthetic': true },
    { $set: set, $push: { 'syntheticRating.history': historyEntry } },
    { timestamps: false, runValidators: true }
  );
  if (result.matchedCount !== 1) {
    throw new AppError('This task does not have a synthetic rating.', 409, 'NOT_SYNTHETIC_RATING');
  }
  logger.info(
    `Synthetic rating ${historyEntry.toRating === '-' ? 'removed' : 'changed'} on task ${task.codeNumber} by ${adminUser.id}: ` +
      `${historyEntry.fromPercent}% (${historyEntry.fromRating}) → ${historyEntry.toPercent === null ? 'none' : `${historyEntry.toPercent}%`} (${historyEntry.toRating})`
  );
  return Task.findById(task._id).populate('assignees', 'name responsibility').populate('createdBy', 'name');
}

// PATCH /tasks/:id/synthetic-rating — a new assumed percentage. The rating is the plain threshold
// rating of that percentage (ratingForPercent): no late downgrade, exactly as when it was assigned.
async function editSyntheticRating(adminUser, taskId, { assumedPercent, note }) {
  const task = await findTaskWithSyntheticRating(taskId);
  const toRating = ratingForPercent(assumedPercent);

  return writeSyntheticRatingChange(task, adminUser, {
    set: { performanceRating: toRating, 'syntheticRating.assumedPercent': assumedPercent },
    historyEntry: {
      at: new Date(),
      by: new mongoose.Types.ObjectId(adminUser.id),
      fromPercent: task.syntheticRating.assumedPercent,
      toPercent: assumedPercent,
      fromRating: task.performanceRating,
      toRating,
      note: note || null,
    },
  });
}

// DELETE /tasks/:id/synthetic-rating — the task goes back to unrated ('-'). The subdocument is
// kept, switched off, as the record of what was once assumed; from here on the task is rated (or
// not) by the real formula like any other.
async function removeSyntheticRating(adminUser, taskId, { note } = {}) {
  const task = await findTaskWithSyntheticRating(taskId);

  return writeSyntheticRatingChange(task, adminUser, {
    set: { performanceRating: '-', 'syntheticRating.isSynthetic': false },
    historyEntry: {
      at: new Date(),
      by: new mongoose.Types.ObjectId(adminUser.id),
      fromPercent: task.syntheticRating.assumedPercent,
      toPercent: null,
      fromRating: task.performanceRating,
      toRating: '-',
      note: note || 'synthetic rating removed',
    },
  });
}

// docs/06-backend.md §4.5 — Phase 6 addition. Called by taskUpdate.service.js's createUpdate,
// inside the same MongoDB transaction, immediately after a new TaskUpdate is created. Mutates and
// saves the given Task document; does not re-fetch/re-populate — that's the caller's job. Accepts
// an optional { session } so the save participates in the caller's transaction, and an optional
// { actorId } (who posted the update) for the history entry written if this update is the one that
// replaces a synthetic rating with a real one — see applyComputedRating.
async function applyNewUpdateToTask(task, updatePayload, { session, actorId } = {}) {
  task.completionPercent = updatePayload.completionPercent;
  task.lastUpdateAt = new Date();
  if (task.completionPercent >= 100 && task.status !== 'closed') {
    task.status = 'complete';
  }
  task.timeStatus = computeTimeStatus(task);
  applyComputedRating(task, { actorId, note: 'synthetic rating replaced by the real rating — task completed' });
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
  ratingForPercent,
  applyNewUpdateToTask,
  editSyntheticRating,
  removeSyntheticRating,
  // Phase 3 addition — exported so reminder-engine.service.js can build its dedupKey's Pakistan
  // calendar-date component from the exact same Karachi-anchored logic startOfDay()/daysBetween()
  // use, rather than reimplementing Intl.DateTimeFormat timezone handling a second time.
  getPakistanDateString,
  startOfDay,
  // Phase 7 addition: exported (unchanged body) so dashboard.service.js can reuse the exact same
  // RBAC-scoping rule listTasks already uses, per docs/06-backend.md §4.1, instead of
  // reimplementing it. Calling buildTaskFilter(requestingUser, {}) yields exactly the scoping
  // clause (nothing else, since every other destructured filter field is undefined) — {} for
  // Admin, { assignees: requestingUser.id } for a User.
  buildTaskFilter,
};
