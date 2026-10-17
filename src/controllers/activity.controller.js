const activityAdminService = require('../services/activityAdmin.service');
const appSettingService = require('../services/appSetting.service');
const activityService = require('../services/activity.service');
const { ACTIVITY_TYPES } = require('../utils/activityTypes');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

// The activity log's admin endpoints — every one Admin only (routes/admin.routes.js).

// GET /admin/activity/summary
const getSummary = asyncHandler(async (req, res) => {
  sendSuccess(res, { data: await activityAdminService.getSummary() });
});

// GET /admin/activity/users
const listUsers = asyncHandler(async (req, res) => {
  const { search, inactiveOnly, page, limit } = req.query;
  const { items, meta } = await activityAdminService.listUsers({ search, inactiveOnly, page, limit });
  sendSuccess(res, { data: items, meta });
});

// GET /admin/activity/users/:id/events
const listEvents = asyncHandler(async (req, res) => {
  const { type, from, to, page, limit } = req.query;
  const { items, meta } = await activityAdminService.listEvents(req.params.id, { type, from, to, page, limit });
  sendSuccess(res, { data: items, meta });
});

// GET /admin/activity/users/:id/history
const listHistory = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const { items, meta } = await activityAdminService.historyBeforeBaseline(req.params.id, { page, limit });
  sendSuccess(res, { data: items, meta });
});

async function currentSettings() {
  const [inactivityDays, baselineAt] = await Promise.all([appSettingService.getInactivityDays(), appSettingService.getActivityBaseline()]);
  return {
    inactivityDays,
    baselineAt,
    minInactivityDays: appSettingService.MIN_INACTIVITY_DAYS,
    maxInactivityDays: appSettingService.MAX_INACTIVITY_DAYS,
  };
}

// GET /admin/settings/activity
const getSettings = asyncHandler(async (req, res) => {
  sendSuccess(res, { data: await currentSettings() });
});

// PATCH /admin/settings/activity — the change itself is logged (old → new).
const updateSettings = asyncHandler(async (req, res) => {
  const { previous, current } = await appSettingService.setInactivityDays(req.body.inactivityDays, req.user.id);
  activityService.record(req, ACTIVITY_TYPES.SETTINGS_CHANGED, { metadata: { setting: 'inactivityDays', from: previous, to: current } });
  sendSuccess(res, { data: await currentSettings() });
});

module.exports = { getSummary, listUsers, listEvents, listHistory, getSettings, updateSettings };
