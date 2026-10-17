const authService = require('../services/auth.service');
const activityService = require('../services/activity.service');
const { ACTIVITY_TYPES } = require('../utils/activityTypes');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

// docs/05-apis.md §2: user representation returned by both /auth/google and /auth/me is exactly
// { id, name, email, role, responsibility } — never the raw Mongoose document, never anything
// beyond this documented shape.
function serializeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    responsibility: user.responsibility,
  };
}

// POST /auth/google — docs/05-apis.md §2
const loginWithGoogle = asyncHandler(async (req, res) => {
  const { token, user } = await authService.loginWithGoogle(req.body.idToken);
  // Activity log: the LOGIN event, and last login / last active (fire-and-forget).
  activityService.recordLogin(user, req);
  sendSuccess(res, { data: { token, user: serializeUser(user) } });
});

// GET /auth/me — docs/05-apis.md §2. Identity comes only from req.user, set by auth.middleware.js
// from the verified JWT + DB lookup — nothing from the request can override it.
const getMe = asyncHandler(async (req, res) => {
  const user = await authService.getCurrentUser(req.user.id);
  sendSuccess(res, { data: serializeUser(user) });
});

// POST /auth/dev-login — docs/12-testing.md §5, non-production only (route registration guarded
// in auth.routes.js, not just here).
const devLogin = asyncHandler(async (req, res) => {
  const { token, user } = await authService.devLogin(req.body.email);
  activityService.recordLogin(user, req);
  sendSuccess(res, { data: { token, user: serializeUser(user) } });
});

// POST /auth/logout — records the LOGOUT event and nothing else: sessions are stateless JWTs, so
// there is nothing to revoke (the app forgets its token on its own). Any signed-in person.
const logout = asyncHandler(async (req, res) => {
  activityService.record(req, ACTIVITY_TYPES.LOGOUT);
  sendSuccess(res, { data: { loggedOut: true } });
});

module.exports = { loginWithGoogle, getMe, devLogin, logout };
