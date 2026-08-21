const asyncHandler = require('../src/utils/asyncHandler');

describe('asyncHandler', () => {
  it('forwards a rejected promise to next()', async () => {
    const err = new Error('boom');
    const handler = asyncHandler(async () => {
      throw err;
    });
    const next = jest.fn();

    await handler({}, {}, next);

    expect(next).toHaveBeenCalledWith(err);
  });

  it('does not call next() when the handler resolves', async () => {
    const handler = asyncHandler(async (req, res) => {
      res.ok = true;
    });
    const res = {};
    const next = jest.fn();

    await handler({}, res, next);

    expect(res.ok).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });
});
