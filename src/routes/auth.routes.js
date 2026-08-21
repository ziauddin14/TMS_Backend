const express = require('express');

const env = require('../config/env');
const authController = require('../controllers/auth.controller');
const authMiddleware = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const { googleLoginSchema, devLoginSchema } = require('../validators/auth.validator');
const { googleAuthRateLimiter } = require('../middleware/rateLimiter.middleware');

const router = express.Router();

// POST /auth/google — public (this is the login call), rate-limited (docs/03-backend-foundation.md §6).
router.post('/google', googleAuthRateLimiter, validate(googleLoginSchema), authController.loginWithGoogle);

// GET /auth/me — any authenticated role.
router.get('/me', authMiddleware, authController.getMe);

// POST /auth/dev-login — docs/12-testing.md §5: "enabled only when NODE_ENV !== 'production',
// never reachable on the real deployed app." The route is only REGISTERED under that condition —
// so in production it does not exist at all (falls through to the app's normal 404), rather than
// existing and merely being blocked at request time. This is checked once at module load, using
// the same validated `env` the rest of the app trusts, never re-derived or duplicated.
if (env.NODE_ENV !== 'production') {
  router.post('/dev-login', validate(devLoginSchema), authController.devLogin);
}

module.exports = router;
