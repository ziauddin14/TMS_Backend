const mongoose = require('mongoose');
const Task = require('../models/Task');
const User = require('../models/User');
const Counter = require('../models/Counter');
const HistoricalImportRecord = require('../models/HistoricalImportRecord');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const {
  ESTIMATE_CONDITION,
  NOT_ESTIMATE_CONDITION,
  ASSIGN_LEDGER_ACTION,
  FINALIZED_LEDGER_ACTION,
  FINALIZED_LEDGER_BATCH,
  isFinalRating,
} = require('../utils/syntheticRating');
const receiptService = require('./receipt.service');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Every task this service returns for an API response carries the names of the people on its
// receipts (task.serializer.js shows them to admins). A task without receipts is unaffected.
const RECEIPT_USERS = { path: 'receipts.user', select: 'name' };
const PERFORMANCE_ORDER = ['excellent', 'good', 'fair', 'weak'];
// The history note when a final rating's band is computed again with the late rule.
const FINAL_BAND_NOTE = 'final rating band recomputed with the late rule';
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

// The date a complete or closed task is judged early/late against: when it was completed
// (completedAt — models/Task.js), else, for a task completed before that field existed, an
// imported task or one closed short of 100%, the fallback chain used before it.
function completionReferenceDate(task) {
  return task.completedAt ?? task.lastUpdateAt ?? task.closedAt ?? task.updatedAt;
}

// Pure functions, no DB access (docs/06-backend.md §4.4, docs/02-db-design.md §7 — corrected
// versions: closeTask DOES recompute both fields, and the closed/complete reference date falls
// back through completedAt ?? lastUpdateAt ?? closedAt ?? updatedAt).
function computeTimeStatus(task, now = new Date()) {
  if (task.status === 'ongoing' || task.status === 'pending') {
    const diffDays = daysBetween(task.deadline, now);
    return diffDays >= 0
      ? { type: 'remaining', days: diffDays }
      : { type: 'overdue', days: Math.abs(diffDays) };
  }
  if (task.status === 'complete' || task.status === 'closed') {
    const referenceDate = completionReferenceDate(task);
    const diffDays = daysBetween(task.deadline, referenceDate);
    return diffDays >= 0
      ? { type: 'early', days: diffDays }
      : { type: 'late', days: Math.abs(diffDays) };
  }
  return { type: 'remaining', days: 0 };
}

// The reminder engine's rule (reminder-engine.service.js maintainTaskState): an ongoing task whose
// deadline has passed is pending. Also applied the moment an update reopens a completed task, so a
// reopened task that is already overdue is pending at once rather than at the next engine run.
// Reads task.timeStatus as already computed; returns whether the status changed.
function applyOverdueRule(task) {
  if (task.timeStatus?.type === 'overdue' && task.status === 'ongoing') {
    task.status = 'pending';
    return true;
  }
  return false;
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

// The band of a FINAL synthetic rating (an admin's edit — utils/syntheticRating.js), whose percent
// P is the percent the admin entered. It is computed exactly like a real rating with P as the
// completion percent — the same thresholds, and ONE level down when the task was completed late —
// once the task is completed (closed, or complete at 100%), with the task's stored timeStatus.
// While the task is still OPEN it has not been completed late (or on time) yet, so the band is the
// plain one of P; it is computed again when the task closes or completes (applyComputedRating).
// A rating that is still only an ESTIMATE never comes here: its band stays ratingForPercent, with
// no late downgrade.
function computeFinalRating(percent, task) {
  if (['complete', 'closed'].includes(task.status)) return computePerformanceRating(percent, task.timeStatus || {}, task.status);
  return ratingForPercent(percent);
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
// - A FINAL synthetic rating (an admin changed it — utils/syntheticRating.js) is never replaced by
//   the real rating, and its percent P (the effective percent) never changes. When the task is
//   closed or completed, only its BAND is computed again from P and the task's lateness at that
//   moment (computeFinalRating) — so a task completed late drops one level, exactly like a real
//   rating. If that changes the band, a history entry by 'system' records it (a string author is
//   never counted as an admin edit). Status, timeStatus, closedAt and completionPercent change as
//   normal. When an update below 100% REOPENS the task, the band goes back to the plain band of P
//   (no downgrade while a task is open), recorded the same way.
//
// A task with no synthetic rating (or one already retired) gets the formula's value, as always —
// so reopening a task gives it '-' again: a completed rating no longer applies.
function applyComputedRating(task, { actorId, note, now = new Date() }) {
  const realRating = computePerformanceRating(task.completionPercent, task.timeStatus, task.status);

  if (task.syntheticRating?.isSynthetic !== true) {
    task.performanceRating = realRating;
    return;
  }
  if (isFinalRating(task.syntheticRating)) {
    const percent = task.syntheticRating.assumedPercent;
    const band = computeFinalRating(percent, task);
    if (band !== task.performanceRating) {
      const event = { closed: 'closed', complete: 'completed' }[task.status] || 'reopened';
      task.syntheticRating.history.push({
        at: now,
        by: 'system',
        fromPercent: percent,
        toPercent: percent,
        fromRating: task.performanceRating,
        toRating: band,
        note: `${FINAL_BAND_NOTE} — task ${event}`,
      });
      task.performanceRating = band;
    }
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

// The `receipt` filter (task receipt — services/receipt.service.js). Only a task's CURRENT
// receipts count (supersededAt null). A task from before the feature has none, so it matches no
// value of this filter. Ids are cast here, not left to Mongoose: the same filter feeds
// Task.aggregate() (dashboard.service.js), which casts nothing.
//   Admin — received: every current receipt confirmed; not_received: none confirmed; partial: some.
//   User  — their own receipt only: received / not_received. `partial` would reveal whether the
//           others on the task confirmed, which is not theirs to see, so it matches nothing.
function receiptFilterClauses(receipt, requestingUser) {
  if (requestingUser.role === 'user') {
    const me = new mongoose.Types.ObjectId(requestingUser.id);
    if (receipt === 'received') {
      return [{ receipts: { $elemMatch: { user: me, supersededAt: null, acknowledgedAt: { $ne: null } } } }];
    }
    if (receipt === 'not_received') {
      return [{ receipts: { $elemMatch: { user: me, supersededAt: null, acknowledgedAt: null } } }];
    }
    return [{ _id: { $in: [] } }];
  }

  const someConfirmed = { receipts: { $elemMatch: { supersededAt: null, acknowledgedAt: { $ne: null } } } };
  const somePending = { receipts: { $elemMatch: { supersededAt: null, acknowledgedAt: null } } };
  if (receipt === 'received') {
    return [someConfirmed, { receipts: { $not: { $elemMatch: { supersededAt: null, acknowledgedAt: null } } } }];
  }
  if (receipt === 'not_received') {
    return [somePending, { receipts: { $not: { $elemMatch: { supersededAt: null, acknowledgedAt: { $ne: null } } } } }];
  }
  return [someConfirmed, somePending];
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
    receipt,
  } = filters;

  const filter = {};
  if (status) filter.status = status;
  if (performanceRating) filter.performanceRating = performanceRating;
  if (responsibility) filter.responsibility = responsibility;

  // Where a rating came from: a developer-assigned one that is still an ESTIMATE, or a real one —
  // i.e. rated AND not an estimate, which includes a FINAL synthetic rating (an admin's edit —
  // utils/syntheticRating.js). Written as $and clauses so they simply combine with a
  // performanceRating filter (a real rating that is also "-" correctly matches nothing) and with
  // the search's own $or.
  if (ratingSource === 'synthetic') {
    filter.$and = [ESTIMATE_CONDITION];
  } else if (ratingSource === 'real') {
    filter.$and = [{ performanceRating: { $ne: '-' } }, NOT_ESTIMATE_CONDITION];
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
  if (receipt) {
    filter.$and = [...(filter.$and || []), ...receiptFilterClauses(receipt, requestingUser)];
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
      .populate(RECEIPT_USERS)
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

  const task = await Task.findById(taskId).populate('assignees', 'name responsibility').populate('createdBy', 'name').populate(RECEIPT_USERS);
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
// `withReceipts` — task receipt: only the app's own POST /tasks passes it (task.controller.js).
// The task then starts with one receipt per eligible assignee, written in the same insert, and
// each of them gets the assignment notice. Any other caller gets exactly the task it always did.
async function createTask(adminUser, { title, assignees, responsibility, deadline }, { withReceipts = false } = {}) {
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
  if (withReceipts) {
    taskData.receipts = await receiptService.buildReceiptsForNewTask(assignees, adminUser);
  }

  const created = await Task.create(taskData);
  if (withReceipts) {
    await receiptService.notifyNewReceipts(created, created.receipts, adminUser);
  }
  return Task.findById(created._id).populate('assignees', 'name responsibility').populate('createdBy', 'name').populate(RECEIPT_USERS);
}

// docs/06-backend.md §4.3 — edits setup fields only, never status/completionPercent/
// performanceRating. Recomputes timeStatus immediately if deadline changed.
// `withReceipts` + `actor` — task receipt: only the app's own PATCH /tasks/:id passes them. When
// the assignees change on a task that takes part, the receipts follow (receipt.service.js
// applyAssigneeChange) and whoever is new on it gets the notice once the task is saved.
async function updateTaskFields(taskId, patch, { actor, withReceipts = false } = {}) {
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

  // What this edit really changes — the activity log records the NAMES of changed fields and who was
  // put on / taken off the task (task.controller.js), never the values. Handed back on $locals.
  const before = {
    title: task.title,
    responsibility: task.responsibility,
    deadline: task.deadline ? new Date(task.deadline).getTime() : null,
    assignees: task.assignees.map(String),
  };

  let addedReceipts = [];
  if (patch.assignees !== undefined) {
    await validateAssignees(patch.assignees);
    task.assignees = patch.assignees;
    if (withReceipts) {
      addedReceipts = await receiptService.applyAssigneeChange(task, patch.assignees, actor);
    }
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
  if (addedReceipts.length > 0) {
    await receiptService.notifyNewReceipts(task, addedReceipts, actor);
  }
  const afterAssignees = task.assignees.map(String);
  const changes = {
    fields: ['title', 'responsibility']
      .filter((field) => task[field] !== before[field])
      .concat((task.deadline ? new Date(task.deadline).getTime() : null) !== before.deadline ? ['deadline'] : []),
    addedAssignees: afterAssignees.filter((id) => !before.assignees.includes(id)),
    removedAssignees: before.assignees.filter((id) => !afterAssignees.includes(id)),
  };
  const updated = await Task.findById(task._id).populate('assignees', 'name responsibility').populate('createdBy', 'name').populate(RECEIPT_USERS);
  updated.$locals.changes = changes;
  return updated;
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
  return Task.findById(task._id).populate('assignees', 'name responsibility').populate('createdBy', 'name').populate(RECEIPT_USERS);
}

// ---- Admin edits of a developer-assigned (synthetic) rating --------------------------------
// Both write with one targeted update — exactly performanceRating, the named syntheticRating
// fields and one new history entry — and with timestamps:false, so nothing else on the task can
// move: not status, completionPercent, lastUpdateAt, timeStatus or updatedAt. No TaskUpdate is
// created and no notification is sent. The history entry (who, when, from → to, note) is the audit
// trail; a log line records it server-side as well.
//
// Only a rating that is still an ESTIMATE can be edited or removed. An edit makes it FINAL
// (utils/syntheticRating.js): it is no longer an estimate, and both endpoints refuse it from then
// on with 409 SYNTHETIC_RATING_FINAL. The edit is also written to the HistoricalImportRecord ledger
// (action 'synthetic-rating-finalized'), in the same transaction as the task.
const FINAL_RATING_MESSAGE = 'This rating is final and can no longer be changed.';
const finalRatingError = () => new AppError(FINAL_RATING_MESSAGE, 409, 'SYNTHETIC_RATING_FINAL');
const notSyntheticError = () => new AppError('This task does not have a synthetic rating.', 409, 'NOT_SYNTHETIC_RATING');

async function findTaskWithEstimate(taskId) {
  if (!mongoose.Types.ObjectId.isValid(taskId)) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }
  const task = await Task.findById(taskId);
  if (!task) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }
  if (task.syntheticRating?.isSynthetic !== true) throw notSyntheticError();
  if (isFinalRating(task.syntheticRating)) throw finalRatingError();
  return task;
}

// The write matches only while the rating is STILL AN ESTIMATE at that moment: a real close in
// between wins instead of being overwritten, and of two simultaneous edits exactly one matches —
// the first one's finalizedAt and history entry make the second miss (it gets the 409). The ledger
// record, when there is one, is committed with the task or not at all.
async function writeSyntheticRatingChange(task, adminUser, { set, historyEntry, ledgerRecord }) {
  const session = await mongoose.startSession();
  let matched = 0;
  try {
    await session.withTransaction(async () => {
      const result = await Task.updateOne(
        { _id: task._id, ...ESTIMATE_CONDITION },
        { $set: set, $push: { 'syntheticRating.history': historyEntry } },
        { session, timestamps: false, runValidators: true }
      );
      matched = result.matchedCount;
      if (matched === 1 && ledgerRecord) await HistoricalImportRecord.create([ledgerRecord], { session });
    });
  } finally {
    await session.endSession();
  }
  if (matched !== 1) {
    const current = await Task.findById(task._id).select('syntheticRating').lean();
    throw isFinalRating(current?.syntheticRating) ? finalRatingError() : notSyntheticError();
  }
  logger.info(
    `Synthetic rating ${historyEntry.toRating === '-' ? 'removed' : 'finalized'} on task ${task.codeNumber} by ${adminUser.id}: ` +
      `${historyEntry.fromPercent}% (${historyEntry.fromRating}) → ${historyEntry.toPercent === null ? 'none' : `${historyEntry.toPercent}%`} (${historyEntry.toRating})`
  );
  return Task.findById(task._id).populate('assignees', 'name responsibility').populate('createdBy', 'name').populate(RECEIPT_USERS);
}

// PATCH /tasks/:id/synthetic-rating — a new percentage, and the rating becomes FINAL. Its band is
// computed like a real rating with that percentage (computeFinalRating): one level down when the
// task was completed late; the plain band while the task is still open. The dialog previews the
// same band, so the band saved is the band the admin saw.
async function editSyntheticRating(adminUser, taskId, { assumedPercent, note }) {
  const task = await findTaskWithEstimate(taskId);
  const toRating = computeFinalRating(assumedPercent, task);
  const now = new Date();
  const adminId = new mongoose.Types.ObjectId(adminUser.id);
  const assignment = await HistoricalImportRecord.findOne({ targetId: task._id, action: ASSIGN_LEDGER_ACTION }).select('personKey').lean();
  const previous = { performanceRating: task.performanceRating, assumedPercent: task.syntheticRating.assumedPercent };

  return writeSyntheticRatingChange(task, adminUser, {
    set: {
      performanceRating: toRating,
      'syntheticRating.assumedPercent': assumedPercent,
      'syntheticRating.finalizedAt': now,
      'syntheticRating.finalizedBy': adminId,
    },
    historyEntry: {
      at: now,
      by: adminId,
      fromPercent: previous.assumedPercent,
      toPercent: assumedPercent,
      fromRating: previous.performanceRating,
      toRating,
      note: note || null,
    },
    ledgerRecord: {
      importBatch: FINALIZED_LEDGER_BATCH,
      sourceKey: `${FINALIZED_LEDGER_ACTION}:${task.codeNumber}`,
      kind: 'syntheticRating',
      action: FINALIZED_LEDGER_ACTION,
      targetId: task._id,
      taskCode: task.codeNumber,
      personKey: assignment?.personKey || 'app:admin-edit',
      flags: { finalizedBy: adminId },
      previous: { ...previous, isSynthetic: true },
      next: { performanceRating: toRating, assumedPercent, finalizedAt: now, finalizedBy: adminId, note: note || null },
    },
  });
}

// DELETE /tasks/:id/synthetic-rating — the task goes back to unrated ('-'). The subdocument is
// kept, switched off, as the record of what was once assumed; from here on the task is rated (or
// not) by the real formula like any other. Only an estimate can be removed — never a final rating.
async function removeSyntheticRating(adminUser, taskId, { note } = {}) {
  const task = await findTaskWithEstimate(taskId);

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
//
// Completion and reopening:
// - An update at 100% or more (from anyone who may post one) takes an open task to complete and
//   stamps completedAt — from then on the date its lateness is measured from. A repeat 100% on a
//   task already complete at 100% (a comment) leaves completedAt as it is; a task completed before
//   completedAt existed gets its current reference date stamped instead, so its early/late result
//   does not move either.
// - An ADMIN's update below 100% on a complete task REOPENS it — createUpdate refuses one from
//   anyone else (403 REOPEN_ADMIN_ONLY) before this is called: completedAt is cleared and the status
//   becomes ongoing — pending if its deadline has already passed (applyOverdueRule, the engine's
//   rule). The real rating goes back to '-'; an estimate stays; a final rating keeps its percent
//   and goes back to the plain band (applyComputedRating). task.$locals.reopened tells the caller
//   (taskUpdate.service.js), which notifies the assignees once the transaction has committed.
// A closed task never gets here (createUpdate rejects it).
async function applyNewUpdateToTask(task, updatePayload, { session, actorId } = {}) {
  const now = new Date();
  const percent = updatePayload.completionPercent;
  const wasComplete = task.status === 'complete';
  let reopened = false;

  if (percent >= 100) {
    if (wasComplete && task.completionPercent >= 100) {
      if (!task.completedAt) task.completedAt = completionReferenceDate(task);
    } else {
      task.completedAt = now;
    }
    task.status = 'complete';
  } else if (wasComplete) {
    task.completedAt = undefined;
    task.status = 'ongoing';
    reopened = true;
  }

  task.completionPercent = percent;
  task.lastUpdateAt = now;
  task.timeStatus = computeTimeStatus(task, now);
  if (reopened) applyOverdueRule(task);
  applyComputedRating(task, { actorId, now, note: 'synthetic rating replaced by the real rating — task completed' });
  task.$locals.reopened = reopened;
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
  completionReferenceDate,
  applyOverdueRule,
  computePerformanceRating,
  computeFinalRating,
  ratingForPercent,
  FINAL_BAND_NOTE,
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
