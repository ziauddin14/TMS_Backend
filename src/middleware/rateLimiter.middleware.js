const rateLimit = require('express-rate-limit');

// docs/03-backend-foundation.md §6: "applied specifically to POST /auth/google (e.g. 20 requests
// / 15 minutes per IP) to blunt brute-force/abuse attempts against the login endpoint." The doc
// phrases this as an illustrative example rather than a firm spec — used verbatim here since it's
// the only concrete figure given anywhere in the docs (flagged in the Phase 3 report, section J).
const googleAuthRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    // Not in the documented Error Code Catalog (docs/05-apis.md §12) — RATE_LIMITED is this
    // implementation's own addition, using the project's standard error envelope (flagged in J).
    res.status(429).json({
      success: false,
      message: 'Too many login attempts. Please try again later.',
      code: 'RATE_LIMITED',
    });
  },
});

module.exports = { googleAuthRateLimiter };
