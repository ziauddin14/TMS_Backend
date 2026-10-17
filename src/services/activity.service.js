const mongoose = require('mongoose');
const ActivityEvent = require('../models/ActivityEvent');
const User = require('../models/User');
const { parseDevice } = require('../utils/userAgent');
const { ACTIVITY_TYPES } = require('../utils/activityTypes');
const logger = require('../utils/logger');

// The activity log's WRITE side: events (models/ActivityEvent.js) and a person's last-login /
// last-active times (models/User.js).
//
// Every write here is FIRE-AND-FORGET: it is started, never awaited by the action being logged,
// and any failure is logged and swallowed — logging can never break or slow the action. Writes
// only ever happen for a signed-in person (req.user), so scripts and the cron endpoints (which
// never load a user) can neither create events nor move anyone's last-active time.

// At most one last-active write per person per this many minutes.
const LAST_ACTIVE_THROTTLE_MINUTES = 10;
const MINUTE_MS = 60 * 1000;

// Writes still in flight — tests await them (flushForTests); nothing else ever does.
const pending = new Set();

function track(promise, what) {
  const settled = promise
    .catch((err) => logger.error(`Activity log: ${what} failed:`, err.message || err))
    .finally(() => pending.delete(settled));
  pending.add(settled);
}

// Metadata is small and safe by contract (see the model). This keeps it so regardless: scalars and
// short lists of scalars only, strings capped, at most 12 keys.
function sanitizeMetadata(metadata = {}) {
  const clean = {};
  Object.entries(metadata || {})
    .slice(0, 12)
    .forEach(([key, value]) => {
      const scalar = (v) => {
        if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
        if (v instanceof mongoose.Types.ObjectId) return String(v);
        if (typeof v === 'string') return v.slice(0, 80);
        return undefined;
      };
      if (Array.isArray(value)) {
        clean[key] = value
          .slice(0, 20)
          .map(scalar)
          .filter((v) => v !== undefined);
      } else if (scalar(value) !== undefined) {
        clean[key] = scalar(value);
      }
    });
  return clean;
}

function buildEvent(userId, type, req, { taskId = null, metadata } = {}, now = new Date()) {
  return {
    user: userId,
    type,
    at: now,
    taskId: taskId || null,
    metadata: sanitizeMetadata(metadata),
    device: parseDevice(req?.headers || {}),
  };
}

// Record that the signed-in person (req.user) did `type`. No signed-in person, no event.
function record(req, type, extra = {}) {
  try {
    if (!req?.user?.id) return;
    track(ActivityEvent.create(buildEvent(req.user.id, type, req, extra)), `recording ${type}`);
  } catch (err) {
    logger.error(`Activity log: recording ${type} failed:`, err.message || err);
  }
}

// A successful sign-in: the LOGIN event, and lastLoginAt + lastActiveAt set to now in one write
// (timestamps:false — the user's updatedAt never moves for this).
function recordLogin(user, req, now = new Date()) {
  try {
    track(
      User.updateOne({ _id: user._id || user.id }, { $set: { lastLoginAt: now, lastActiveAt: now } }, { timestamps: false }),
      'updating last login'
    );
    track(ActivityEvent.create(buildEvent(user._id || user.id, ACTIVITY_TYPES.LOGIN, req, {}, now)), 'recording LOGIN');
  } catch (err) {
    logger.error('Activity log: recording LOGIN failed:', err.message || err);
  }
}

// Called by authMiddleware on every authenticated request, with the user it just loaded. Writes
// only when the last recorded activity is older than LAST_ACTIVE_THROTTLE_MINUTES — so ordinary
// requests cost no write at all — and then with ONE conditional update that only matches while
// that is still true (two requests at once cannot both write). timestamps:false: updatedAt never
// moves.
function touchLastActive(user, now = new Date()) {
  try {
    const cutoff = new Date(now.getTime() - LAST_ACTIVE_THROTTLE_MINUTES * MINUTE_MS);
    if (user.lastActiveAt && new Date(user.lastActiveAt) > cutoff) return;
    track(
      User.updateOne(
        { _id: user._id, $or: [{ lastActiveAt: { $exists: false } }, { lastActiveAt: null }, { lastActiveAt: { $lte: cutoff } }] },
        { $set: { lastActiveAt: now } },
        { timestamps: false }
      ),
      'updating last active'
    );
  } catch (err) {
    logger.error('Activity log: updating last active failed:', err.message || err);
  }
}

// Tests only: wait for every write started so far.
async function flushForTests() {
  while (pending.size > 0) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all([...pending]);
  }
}

module.exports = { LAST_ACTIVE_THROTTLE_MINUTES, record, recordLogin, touchLastActive, sanitizeMetadata, flushForTests };
