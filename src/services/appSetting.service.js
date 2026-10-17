const AppSetting = require('../models/AppSetting');
const logger = require('../utils/logger');

// App-wide settings (models/AppSetting.js). For now: the activity log's inactivity threshold and
// its baseline.

const INACTIVITY_DAYS_KEY = 'inactivityDays';
const BASELINE_KEY = 'activityBaselineAt';
const DEFAULT_INACTIVITY_DAYS = 7;
const MIN_INACTIVITY_DAYS = 1;
const MAX_INACTIVITY_DAYS = 90;

// The baseline never changes once written, so it is kept in memory after the first read.
let cachedBaseline = null;

// When activity recording began — written ONCE, atomically ($setOnInsert on a unique key), the
// first time this runs after the feature is deployed: at server start (server.js), or lazily on the
// first read if that start-up write did not happen. A second call (another start, a race) finds
// the existing value and returns it unchanged.
async function ensureActivityBaseline(now = new Date()) {
  if (cachedBaseline) return cachedBaseline;
  let doc;
  try {
    doc = await AppSetting.findOneAndUpdate(
      { key: BASELINE_KEY },
      { $setOnInsert: { key: BASELINE_KEY, value: now } },
      { upsert: true, new: true }
    );
  } catch (err) {
    // Two first-ever upserts at the same moment: the loser hits the unique index — the winner's
    // value is the baseline.
    if (err.code !== 11000) throw err;
    doc = await AppSetting.findOne({ key: BASELINE_KEY });
  }
  cachedBaseline = new Date(doc.value);
  return cachedBaseline;
}

async function getActivityBaseline() {
  return ensureActivityBaseline();
}

async function getInactivityDays() {
  const doc = await AppSetting.findOne({ key: INACTIVITY_DAYS_KEY }).lean();
  const value = Number(doc?.value);
  return Number.isInteger(value) && value >= MIN_INACTIVITY_DAYS && value <= MAX_INACTIVITY_DAYS ? value : DEFAULT_INACTIVITY_DAYS;
}

// Returns { previous, current } so the caller can log the change. Validation of the range happens
// in the request validator; this is the stored value.
async function setInactivityDays(days, adminUserId) {
  const previous = await getInactivityDays();
  await AppSetting.findOneAndUpdate(
    { key: INACTIVITY_DAYS_KEY },
    { $set: { key: INACTIVITY_DAYS_KEY, value: days, updatedBy: adminUserId } },
    { upsert: true, new: true }
  );
  return { previous, current: days };
}

// Server start: make sure the baseline exists. Never allowed to stop the server.
function ensureActivityBaselineAtStartup() {
  ensureActivityBaseline().catch((err) => logger.error('Activity baseline could not be written at startup:', err.message || err));
}

// Tests only: forget the cached baseline (each test file starts from an empty database).
function resetCacheForTests() {
  cachedBaseline = null;
}

module.exports = {
  DEFAULT_INACTIVITY_DAYS,
  MIN_INACTIVITY_DAYS,
  MAX_INACTIVITY_DAYS,
  ensureActivityBaseline,
  ensureActivityBaselineAtStartup,
  getActivityBaseline,
  getInactivityDays,
  setInactivityDays,
  resetCacheForTests,
};
