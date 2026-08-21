const jwt = require('jsonwebtoken');

const env = require('../config/env');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const User = require('../models/User');

// Not in the documented Error Code Catalog (docs/05-apis.md §12 only defines INVALID_TOKEN for
// the Google-token-verification stage at login). UNAUTHORIZED is this implementation's own
// addition for the separate case of a protected route rejecting the app's own JWT — flagged in
// the Phase 3 report, section J. A single generic code/message for every JWT failure mode
// (missing, malformed, expired, wrong signature, unknown/deactivated user) is deliberate: the
// documented frontend interceptor (docs/07-frontend-foundation.md §6) treats any 401 identically
// — clear the session and redirect to /login — so finer-grained codes would have no consumer.
const SESSION_INVALID = () =>
  new AppError('Session expired or invalid. Please sign in again.', 401, 'UNAUTHORIZED');

/**
 * docs/03-backend-foundation.md §6: "reads Authorization: Bearer <jwt>, verifies it, attaches
 * req.user = { id, role, name, email }." The JWT payload only carries { sub, role }
 * (docs/06-backend.md §1 issueSessionToken), so name/email/responsibility require a DB lookup by
 * the verified `sub` claim — the identity always originates from the verified token + trusted
 * database record, never from anything the client sends.
 *
 * That same lookup is also used to re-check `isActive` on every request (not just at login), so a
 * user deactivated mid-session stops being able to use an already-issued token — a direct, minimal
 * consequence of a documented behavior (docs/02-db-design.md's deactivate-instead-of-delete
 * rule), not a new feature. Flagged in the Phase 3 report, section J.
 */
const authMiddleware = asyncHandler(async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw SESSION_INVALID();
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw SESSION_INVALID();
  }

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    throw SESSION_INVALID();
  }

  if (!payload || !payload.sub) {
    throw SESSION_INVALID();
  }

  const user = await User.findById(payload.sub);
  if (!user || !user.isActive) {
    throw SESSION_INVALID();
  }

  req.user = {
    id: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    responsibility: user.responsibility,
  };
  next();
});

module.exports = authMiddleware;
