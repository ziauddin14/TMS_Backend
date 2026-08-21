const AppError = require('../src/utils/AppError');
const errorHandler = require('../src/middleware/error.middleware');
const logger = require('../src/utils/logger');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('centralized error handler', () => {
  it('maps a known AppError to its statusCode, message, and code', () => {
    const err = new AppError('Task not found', 404, 'TASK_NOT_FOUND');
    const res = mockRes();

    errorHandler(err, {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Task not found',
      code: 'TASK_NOT_FOUND',
    });
  });

  it('maps an unexpected error to a generic 500 without leaking internal details', () => {
    // This path deliberately logs server-side (asserted below), so silence it in test output.
    const logSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const err = new Error('connection string leaked here');
    const res = mockRes();

    errorHandler(err, {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Internal server error',
      code: 'SERVER_ERROR',
    });
    expect(logSpy).toHaveBeenCalledWith('Unhandled error:', err);

    logSpy.mockRestore();
  });

  it('includes a details array on the response when the AppError carries one (e.g. VALIDATION_ERROR)', () => {
    const details = [{ field: 'idToken', message: 'idToken is required' }];
    const err = new AppError('Validation failed.', 400, 'VALIDATION_ERROR', details);
    const res = mockRes();

    errorHandler(err, {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Validation failed.',
      code: 'VALIDATION_ERROR',
      details,
    });
  });

  it('omits details entirely (not even as undefined) when the AppError does not carry one', () => {
    const err = new AppError('Task not found', 404, 'TASK_NOT_FOUND');
    const res = mockRes();

    errorHandler(err, {}, res, jest.fn());

    const body = res.json.mock.calls[0][0];
    expect('details' in body).toBe(false);
  });
});
