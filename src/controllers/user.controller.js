const userService = require('../services/user.service');
const activityService = require('../services/activity.service');
const { ACTIVITY_TYPES } = require('../utils/activityTypes');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

// The Users module's own representation includes isActive (needed for the Users page's Active/
// Inactive Status column — docs/08-ui-ux.md §8) — deliberately distinct from the slimmer identity
// shape auth.controller.js returns for login/me.
function serializeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    responsibility: user.responsibility,
    role: user.role,
    isActive: user.isActive,
  };
}

// GET /users — Admin only (docs/05-apis.md §3)
const listUsers = asyncHandler(async (req, res) => {
  const { role, isActive, search, page, limit } = req.query;
  const { items, meta } = await userService.listUsers({ role, isActive, search }, { page, limit });
  sendSuccess(res, { data: items.map(serializeUser), meta });
});

// GET /users/:id — Admin or self (ownership rule enforced in the service)
const getUser = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.user, req.params.id);
  sendSuccess(res, { data: serializeUser(user) });
});

// POST /users — Admin only
const createUser = asyncHandler(async (req, res) => {
  const user = await userService.createUser(req.body);
  activityService.record(req, ACTIVITY_TYPES.USER_CREATED, { metadata: { targetUserId: user.id, role: user.role } });
  sendSuccess(res, { data: serializeUser(user), statusCode: 201 });
});

// PATCH /users/:id — Admin only
const updateUser = asyncHandler(async (req, res) => {
  const user = await userService.updateUser(req.params.id, req.body);
  // Activity log: a deactivation / reactivation as such, other changes by field NAME.
  const changes = user.$locals.changes || { fields: [], wasActive: user.isActive };
  if (changes.wasActive && !user.isActive) {
    activityService.record(req, ACTIVITY_TYPES.USER_DEACTIVATED, { metadata: { targetUserId: user.id } });
  } else if (!changes.wasActive && user.isActive) {
    activityService.record(req, ACTIVITY_TYPES.USER_REACTIVATED, { metadata: { targetUserId: user.id } });
  }
  if (changes.fields.length > 0) {
    activityService.record(req, ACTIVITY_TYPES.USER_UPDATED, { metadata: { targetUserId: user.id, fields: changes.fields } });
  }
  sendSuccess(res, { data: serializeUser(user) });
});

module.exports = { listUsers, getUser, createUser, updateUser };
