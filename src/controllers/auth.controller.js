const authService = require('../services/auth.service');
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
  sendSuccess(res, { data: { token, user: serializeUser(user) } });
});

module.exports = { loginWithGoogle, getMe, devLogin };
