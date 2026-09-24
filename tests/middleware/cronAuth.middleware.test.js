const TEST_SECRET = 'test-secret-1234567890-abcdefghij-32chars';

jest.mock('../../src/config/env', () => ({ CRON_SECRET: 'test-secret-1234567890-abcdefghij-32chars' }));

const mockAuthMiddleware = jest.fn((req, res, next) => next());
jest.mock('../../src/middleware/auth.middleware', () => (...args) => mockAuthMiddleware(...args));

const mockRequireAdminRole = jest.fn((req, res, next) => next());
jest.mock('../../src/middleware/role.middleware', () => () => (...args) => mockRequireAdminRole(...args));

const requireCronSecretOrAdmin = require('../../src/middleware/cronAuth.middleware');

function makeReq(cronSecretHeader) {
  return { get: (name) => (name === 'X-Cron-Secret' ? cronSecretHeader : undefined) };
}

describe('cronAuth middleware (requireCronSecretOrAdmin) — dual-auth gate for POST /admin/trigger-reminders', () => {
  afterEach(() => jest.clearAllMocks());

  it('a correct X-Cron-Secret header proceeds straight to the controller, WITHOUT ever calling authMiddleware', () => {
    const next = jest.fn();

    requireCronSecretOrAdmin(makeReq(TEST_SECRET), {}, next);

    expect(next).toHaveBeenCalledWith(); // no error argument -> proceeds
    expect(mockAuthMiddleware).not.toHaveBeenCalled();
    expect(mockRequireAdminRole).not.toHaveBeenCalled();
  });

  it('a wrong X-Cron-Secret header is a clean 401 INVALID_CRON_SECRET — the JWT flow is never attempted', () => {
    const next = jest.fn();

    requireCronSecretOrAdmin(makeReq('completely-wrong-value'), {}, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, code: 'INVALID_CRON_SECRET' })
    );
    expect(mockAuthMiddleware).not.toHaveBeenCalled();
    expect(mockRequireAdminRole).not.toHaveBeenCalled();
  });

  it('a header of a different length is rejected the same way (length-mismatch branch of the constant-time compare)', () => {
    const next = jest.fn();

    requireCronSecretOrAdmin(makeReq('short'), {}, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, code: 'INVALID_CRON_SECRET' })
    );
  });

  it('an empty-string header value is treated as present-but-wrong (401), not as "header absent"', () => {
    const next = jest.fn();

    requireCronSecretOrAdmin(makeReq(''), {}, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, code: 'INVALID_CRON_SECRET' })
    );
    expect(mockAuthMiddleware).not.toHaveBeenCalled();
  });

  it('no X-Cron-Secret header at all falls through to the normal authMiddleware + requireRole("admin") chain, unmodified', () => {
    const next = jest.fn();

    requireCronSecretOrAdmin(makeReq(undefined), {}, next);

    expect(mockAuthMiddleware).toHaveBeenCalledTimes(1);
    expect(mockRequireAdminRole).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // both mocks succeed -> ultimately proceeds
  });

  it('when the header is absent and authMiddleware itself fails, that error propagates and role is never checked', () => {
    mockAuthMiddleware.mockImplementationOnce((req, res, cb) => cb(new Error('session invalid')));
    const next = jest.fn();

    requireCronSecretOrAdmin(makeReq(undefined), {}, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(mockRequireAdminRole).not.toHaveBeenCalled();
  });
});
