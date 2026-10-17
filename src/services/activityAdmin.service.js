const mongoose = require('mongoose');
const User = require('../models/User');
const ActivityEvent = require('../models/ActivityEvent');
const TaskUpdate = require('../models/TaskUpdate');
const AppError = require('../utils/AppError');
const appSettingService = require('./appSetting.service');
const { getPakistanDateString } = require('./task.service');

// The activity log's READ side — admin only (routes/admin.routes.js): the summary tiles, the list
// of accounts with their last login / last activity / last action and the inactivity flag, one
// person's timeline, and their task updates from before the log began.

const DAY_MS = 24 * 60 * 60 * 1000;
// Pakistan is UTC+5 all year (no daylight saving since 2009), so a Pakistan calendar date's
// midnight is that date at 00:00+05:00.
const KARACHI_OFFSET = '+05:00';

function karachiDayStart(dateString) {
  return new Date(`${dateString}T00:00:00${KARACHI_OFFSET}`);
}

function latest(...dates) {
  return dates.filter(Boolean).reduce((max, d) => (new Date(d) > max ? new Date(d) : max), new Date(0));
}

// The moment a person's inactivity is counted from: the latest of their last activity, their last
// login, when their account was created, and when the log began (the baseline). So nobody is
// flagged in the first N days after the feature goes live, and a new account gets N full days.
function effectiveActivityTime(user, baseline) {
  return latest(user.lastActiveAt, user.lastLoginAt, user.createdAt, baseline);
}

// Flagged when the account is ACTIVE and that moment is more than N whole days (N x 24h) ago.
// A deactivated account is never flagged. Only the four times above take part — task updates
// from before the baseline (historyBeforeBaseline below) never do.
function isInactive(user, { now, baseline, days }) {
  if (!user.isActive) return false;
  return now.getTime() - effectiveActivityTime(user, baseline).getTime() > days * DAY_MS;
}

function daysSince(time, now) {
  return Math.max(0, Math.floor((now.getTime() - new Date(time).getTime()) / DAY_MS));
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const USER_FIELDS = 'name email responsibility role isActive createdAt lastLoginAt lastActiveAt';

async function context(now) {
  const [baseline, days] = await Promise.all([appSettingService.getActivityBaseline(), appSettingService.getInactivityDays()]);
  return { now, baseline, days };
}

// GET /admin/activity/summary — active accounts only. "Today" is the current Pakistan calendar
// day; "this week" the last 7 x 24 hours (rolling).
async function getSummary(now = new Date()) {
  const ctx = await context(now);
  const users = await User.find({ isActive: true }).select(USER_FIELDS).lean();
  const todayStart = karachiDayStart(getPakistanDateString(now));
  const weekStart = new Date(now.getTime() - 7 * DAY_MS);
  const activeSince = (since) => users.filter((u) => u.lastActiveAt && new Date(u.lastActiveAt) >= since).length;

  return {
    inactivityDays: ctx.days,
    baselineAt: ctx.baseline,
    totalActive: users.length,
    activeToday: activeSince(todayStart),
    activeThisWeek: activeSince(weekStart),
    inactiveCount: users.filter((u) => isInactive(u, ctx)).length,
  };
}

// The latest event of each listed person, one query (index { user: 1, at: -1 }).
async function lastActions(userIds) {
  if (userIds.length === 0) return new Map();
  const rows = await ActivityEvent.aggregate([
    { $match: { user: { $in: userIds } } },
    { $sort: { user: 1, at: -1 } },
    { $group: { _id: '$user', type: { $first: '$type' }, at: { $first: '$at' }, taskId: { $first: '$taskId' }, metadata: { $first: '$metadata' } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), { type: row.type, at: row.at, taskCode: row.metadata?.taskCode || null }]));
}

// GET /admin/activity/users — every ACTIVE account (admins included), most inactive first. A search
// (name, email or responsibility) also finds deactivated accounts, shown but never flagged, so their
// history stays reachable. At this project's size (a few dozen accounts) every row is computed and
// the page is cut afterwards.
async function listUsers({ search, inactiveOnly, page = 1, limit = 20 } = {}, now = new Date()) {
  const ctx = await context(now);
  const filter = {};
  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: regex }, { email: regex }, { responsibility: regex }];
  } else {
    filter.isActive = true;
  }
  const users = await User.find(filter).select(USER_FIELDS).lean();
  const actions = await lastActions(users.map((u) => u._id));

  let rows = users.map((u) => {
    const effective = effectiveActivityTime(u, ctx.baseline);
    return {
      id: String(u._id),
      name: u.name,
      responsibility: u.responsibility,
      role: u.role,
      isActive: u.isActive,
      lastLoginAt: u.lastLoginAt || null,
      lastActiveAt: u.lastActiveAt || null,
      lastAction: actions.get(String(u._id)) || null,
      // No activity recorded at all since the log began — the screen then says so in neutral
      // words rather than claiming the person never signed in.
      noActivityRecorded: !u.lastActiveAt && !u.lastLoginAt,
      daysSinceActivity: daysSince(effective, now),
      isInactive: isInactive(u, ctx),
    };
  });
  if (inactiveOnly) rows = rows.filter((row) => row.isInactive);
  rows.sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.daysSinceActivity - a.daysSinceActivity || a.name.localeCompare(b.name));

  const total = rows.length;
  const start = (page - 1) * limit;
  return {
    items: rows.slice(start, start + limit),
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), inactivityDays: ctx.days, baselineAt: ctx.baseline },
  };
}

async function findUserOr404(userId) {
  if (!mongoose.Types.ObjectId.isValid(userId)) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
  const user = await User.findById(userId).select('name isActive').lean();
  if (!user) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
  return user;
}

// GET /admin/activity/users/:id/events — one person's events, newest first. `from` / `to` are
// Pakistan calendar dates (YYYY-MM-DD), both whole days included.
async function listEvents(userId, { type, from, to, page = 1, limit = 20 } = {}) {
  await findUserOr404(userId);
  const filter = { user: new mongoose.Types.ObjectId(userId) };
  if (type) filter.type = type;
  if (from || to) {
    filter.at = {};
    if (from) filter.at.$gte = karachiDayStart(from);
    if (to) filter.at.$lt = new Date(karachiDayStart(to).getTime() + DAY_MS);
  }
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    ActivityEvent.find(filter).sort({ at: -1 }).skip(skip).limit(limit).populate('taskId', 'codeNumber').lean(),
    ActivityEvent.countDocuments(filter),
  ]);
  return {
    items: items.map((event) => ({
      id: String(event._id),
      type: event.type,
      at: event.at,
      task: event.taskId ? { id: String(event.taskId._id), codeNumber: event.taskId.codeNumber } : null,
      taskCode: event.taskId?.codeNumber || event.metadata?.taskCode || null,
      device: event.device || null,
    })),
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

// GET /admin/activity/users/:id/history — the person's task updates from BEFORE the log began,
// read from the existing TaskUpdate collection at query time (never copied anywhere): when, which
// task, what percent — never the update's text. Shown in the timeline only; never part of the
// inactivity result.
async function historyBeforeBaseline(userId, { page = 1, limit = 10 } = {}) {
  await findUserOr404(userId);
  const baseline = await appSettingService.getActivityBaseline();
  const filter = { updatedBy: new mongoose.Types.ObjectId(userId), createdAt: { $lt: baseline } };
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    TaskUpdate.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).select('taskId completionPercent createdAt').populate('taskId', 'codeNumber').lean(),
    TaskUpdate.countDocuments(filter),
  ]);
  return {
    items: items.map((update) => ({
      id: String(update._id),
      at: update.createdAt,
      taskCode: update.taskId?.codeNumber || null,
      completionPercent: update.completionPercent,
    })),
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), baselineAt: baseline },
  };
}

module.exports = {
  effectiveActivityTime,
  isInactive,
  daysSince,
  karachiDayStart,
  getSummary,
  listUsers,
  listEvents,
  historyBeforeBaseline,
};
