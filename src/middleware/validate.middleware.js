const AppError = require('../utils/AppError');

// Generic zod-schema request validator (docs/03-backend-foundation.md §8: "every route that
// accepts a body/query gets a zod schema in validators/, run via a small validate(schema)
// middleware placed right after the route path and before the controller"). Defaults to
// validating req.body (all of Phase 3's usage); pass 'query' as the second argument to validate
// req.query instead (needed by Phase 4's GET /users query params) — same function, same pattern,
// not a second validator.
function validate(schema, source = 'body') {
  return function validateMiddleware(req, res, next) {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || `(${source})`,
        message: issue.message,
      }));
      return next(new AppError('Validation failed.', 400, 'VALIDATION_ERROR', details));
    }

    req[source] = result.data; // normalized: unknown fields stripped, defaults applied
    next();
  };
}

module.exports = validate;
