const AppError = require('../utils/AppError');

// docs/03-backend-foundation.md §6: "role.middleware.js — requireRole('admin') — used on
// Admin-only routes." Documented roles only (docs/04-db-models.md §2: enum ['admin','user']) —
// this is a generic factory, it does not invent any role itself. Pure authorization check: it
// only compares req.user.role (set by auth.middleware.js from the verified token + DB lookup,
// never from client input) against the required role — no business logic.
function requireRole(role) {
  return function roleMiddleware(req, res, next) {
    if (!req.user || req.user.role !== role) {
      return next(
        new AppError('You are not authorized to perform this action.', 403, 'FORBIDDEN_ROLE')
      );
    }
    next();
  };
}

module.exports = requireRole;
