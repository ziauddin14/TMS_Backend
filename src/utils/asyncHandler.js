// Wraps an async route/controller handler so rejected promises are forwarded
// to Express's error-handling middleware instead of needing a try/catch in every controller.
// Returns the settled promise (Express itself ignores it, but this makes a wrapped handler
// properly awaitable — required by Phase 3's direct middleware unit tests, which await a real
// async DB lookup inside; without returning here, `await wrapped(...)` resolved a tick before the
// inner async work actually finished).
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    return Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
