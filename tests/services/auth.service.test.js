const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const authService = require('../../src/services/auth.service');

beforeAll(async () => connect());
afterEach(async () => {
  await clearDatabase();
  mockVerifyIdToken.mockReset();
});
afterAll(async () => closeDatabase());

function mockTicket(payload) {
  return { getPayload: () => payload };
}

function googlePayload(overrides = {}) {
  return { email: 'user@dawateislami.net', email_verified: true, ...overrides };
}

describe('authService.loginWithGoogle', () => {
  it('logs in an existing active user with a valid Google token', async () => {
    const user = await User.create({
      name: 'Om',
      email: 'user@dawateislami.net',
      responsibility: 'Donation Box Incharge',
      role: 'user',
    });
    mockVerifyIdToken.mockResolvedValue(mockTicket(googlePayload()));

    const { token, user: loggedIn } = await authService.loginWithGoogle('valid-id-token');

    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3); // looks like a real JWT
    expect(loggedIn.id).toBe(user.id);
  });

  it('rejects when the Google token fails verification', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('bad signature'));
    await expect(authService.loginWithGoogle('bad-token')).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
      statusCode: 400,
    });
  });

  it('rejects when the token has no usable payload', async () => {
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => null });
    await expect(authService.loginWithGoogle('token')).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('rejects when email_verified is false (does not trust an unverified email)', async () => {
    await User.create({ name: 'X', email: 'user@dawateislami.net', responsibility: 'X' });
    mockVerifyIdToken.mockResolvedValue(mockTicket(googlePayload({ email_verified: false })));
    await expect(authService.loginWithGoogle('token')).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('rejects an email not present in the users collection (does not auto-create a user)', async () => {
    mockVerifyIdToken.mockResolvedValue(mockTicket(googlePayload({ email: 'ghost@dawateislami.net' })));
    await expect(authService.loginWithGoogle('token')).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
      statusCode: 403,
    });
    await expect(User.findOne({ email: 'ghost@dawateislami.net' })).resolves.toBeNull();
  });

  it('rejects a deactivated user', async () => {
    await User.create({
      name: 'X',
      email: 'inactive@dawateislami.net',
      responsibility: 'X',
      isActive: false,
    });
    mockVerifyIdToken.mockResolvedValue(mockTicket(googlePayload({ email: 'inactive@dawateislami.net' })));
    await expect(authService.loginWithGoogle('token')).rejects.toMatchObject({
      code: 'USER_INACTIVE',
      statusCode: 403,
    });
  });

  it('matches the email case-insensitively', async () => {
    await User.create({ name: 'X', email: 'case@dawateislami.net', responsibility: 'X' });
    mockVerifyIdToken.mockResolvedValue(mockTicket(googlePayload({ email: 'CASE@DawateIslami.net' })));
    const { user } = await authService.loginWithGoogle('token');
    expect(user.email).toBe('case@dawateislami.net');
  });

  it('the issued JWT payload never carries the JWT secret or sensitive Google token internals', async () => {
    const jwt = require('jsonwebtoken');
    const user = await User.create({ name: 'X', email: 'claims@dawateislami.net', responsibility: 'X' });
    mockVerifyIdToken.mockResolvedValue(mockTicket(googlePayload({ email: 'claims@dawateislami.net' })));

    const { token } = await authService.loginWithGoogle('token');
    const decoded = jwt.decode(token);

    expect(decoded).toMatchObject({ sub: user.id, role: 'user' });
    expect(Object.keys(decoded).sort()).toEqual(['exp', 'iat', 'role', 'sub'].sort());
  });
});

describe('authService.assertAllowedDomain (pure function, docs/01-architecture.md §5.1 item 7)', () => {
  it('does not restrict when allowedHd is empty/unset (approved decision)', () => {
    expect(() => authService.assertAllowedDomain({ hd: 'anything.com' }, '')).not.toThrow();
    expect(() => authService.assertAllowedDomain({}, undefined)).not.toThrow();
  });

  it('allows a matching hosted domain when configured', () => {
    expect(() =>
      authService.assertAllowedDomain({ hd: 'dawateislami.net' }, 'dawateislami.net')
    ).not.toThrow();
  });

  it('rejects a non-matching hosted domain when configured', () => {
    expect(() => authService.assertAllowedDomain({ hd: 'gmail.com' }, 'dawateislami.net')).toThrow();
  });

  it('rejects a personal account with no hd claim when a domain is configured (does not trust a bare email string)', () => {
    expect(() =>
      authService.assertAllowedDomain({ email: 'someone@dawateislami.net' }, 'dawateislami.net')
    ).toThrow();
  });

  it('is case-insensitive when comparing domains', () => {
    expect(() =>
      authService.assertAllowedDomain({ hd: 'DawateIslami.NET' }, 'dawateislami.net')
    ).not.toThrow();
  });
});

describe('authService.devLogin', () => {
  it('logs in an existing user without any Google verification call', async () => {
    const user = await User.create({ name: 'Dev', email: 'dev@dawateislami.net', responsibility: 'X' });
    const { token, user: loggedIn } = await authService.devLogin('dev@dawateislami.net');
    expect(loggedIn.id).toBe(user.id);
    expect(typeof token).toBe('string');
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it('rejects an unregistered email the same way real login would', async () => {
    await expect(authService.devLogin('nope@dawateislami.net')).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
  });

  it('rejects a deactivated user the same way real login would', async () => {
    await User.create({ name: 'X', email: 'off@dawateislami.net', responsibility: 'X', isActive: false });
    await expect(authService.devLogin('off@dawateislami.net')).rejects.toMatchObject({
      code: 'USER_INACTIVE',
    });
  });
});
