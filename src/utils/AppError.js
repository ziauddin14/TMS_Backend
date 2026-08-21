class AppError extends Error {
  // `details` is optional (undefined for almost every error) — used only by VALIDATION_ERROR to
  // carry the field-level array the API contract requires (docs/05-apis.md §1).
  constructor(message, statusCode = 500, code = 'SERVER_ERROR', details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
