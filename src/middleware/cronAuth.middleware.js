const crypto = require('crypto');

const env = require('../config/env');
const AppError = require('../utils/AppError');
const authMiddleware = require('./auth.middleware');
const requireRole = require('./role.middleware');

const requireAdminRole = requireRole('admin');

// Constant-time comparison — a plain `===` on a shared secret leaks timing information about how
// many leading bytes matched, which is a real (if narrow) attack surface for a header any
// unauthenticated caller can send. Buffer lengths are checked first because
// crypto.timingSafeEqual throws (rather than returning false) on a length mismatch.
function secretsMatch(provided, expected) {
  const providedBuf = Buffer.from(String(provided));
  const expectedBuf = Buffer.from(String(expected));
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

// Dual-auth gate for POST /admin/trigger-reminders ONLY (Render's own Cron Jobs require a paid
// plan — see the Phase 3 deployment report — so a GitHub Actions scheduled workflow calls this
// endpoint directly instead, authenticating with a shared secret rather than an Admin session).
//
// If the X-Cron-Secret header is present AT ALL, this request is treated as a cron-authenticated
// call: an exact (constant-time) match against CRON_SECRET proceeds straight to the controller —
// no JWT/session involved, matching runReminderEngine()'s own server-resolved-recipients security
// model (nothing about who can trigger a scan changes what it's allowed to do). Any other value
// is a clean 401 — deliberately NOT falling through to the normal JWT flow, so a wrong or
// leaked-but-invalid secret can never be silently retried as if it were an ordinary logged-out
// browser request.
//
// Absent the header entirely, this is byte-for-byte the same authMiddleware + requireRole('admin')
// chain every other /admin/* route already uses — the existing Admin-login path is unmodified.
function requireCronSecretOrAdmin(req, res, next) {
  const provided = req.get('X-Cron-Secret');

  if (provided !== undefined) {
    if (secretsMatch(provided, env.CRON_SECRET)) {
      return next();
    }
    return next(new AppError('Invalid cron secret.', 401, 'INVALID_CRON_SECRET'));
  }

  return authMiddleware(req, res, (err) => {
    if (err) return next(err);
    return requireAdminRole(req, res, next);
  });
}

module.exports = requireCronSecretOrAdmin;
