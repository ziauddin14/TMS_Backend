// Standard success/error JSON envelope, per docs/03-backend-foundation.md §7:
//   success: { success: true, data, meta? }
//   error:   { success: false, message, code }

function sendSuccess(res, { data = null, meta, statusCode = 200 } = {}) {
  const body = { success: true, data };
  if (meta !== undefined) body.meta = meta;
  return res.status(statusCode).json(body);
}

function sendError(res, { statusCode = 500, message = 'Something went wrong', code = 'SERVER_ERROR', details } = {}) {
  const body = { success: false, message, code };
  if (details !== undefined) body.details = details;
  return res.status(statusCode).json(body);
}

module.exports = { sendSuccess, sendError };
