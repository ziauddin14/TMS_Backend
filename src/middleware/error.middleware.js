const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { sendError } = require('../utils/apiResponse');

// Express identifies error-handling middleware by arity (4 params), so `next` must stay
// declared even though this is always the last middleware in the stack.
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return sendError(res, {
      statusCode: err.statusCode,
      message: err.message,
      code: err.code,
      details: err.details,
    });
  }

  logger.error('Unhandled error:', err);
  return sendError(res, {
    statusCode: 500,
    message: 'Internal server error',
    code: 'SERVER_ERROR',
  });
}

module.exports = errorHandler;
