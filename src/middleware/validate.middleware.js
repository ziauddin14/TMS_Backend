const AppError = require('../utils/AppError');

// Generic zod-schema request-body validator (docs/03-backend-foundation.md §8: "every route that
// accepts a body/query gets a zod schema in validators/, run via a small validate(schema)
// middleware placed right after the route path and before the controller"). First real usage is
// the Auth endpoints in this phase; later phases reuse it unchanged for their own validators.
function validate(schema) {
  return function validateMiddleware(req, res, next) {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(body)',
        message: issue.message,
      }));
      return next(new AppError('Validation failed.', 400, 'VALIDATION_ERROR', details));
    }

    req.body = result.data; // normalized: unknown fields stripped, defaults applied
    next();
  };
}

module.exports = validate;
