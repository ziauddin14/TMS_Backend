const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');

beforeAll(async () => connect());
afterEach(async () => {
  await clearDatabase();
  mockVerifyIdToken.mockReset();
});
afterAll(async () => closeDatabase());

function mockTicket(payload) {
  return { getPayload: () => payload };
}

describe('POST /api/v1/auth/google', () => {
  it('returns a token and the documented user shape for a valid login', async () => {
    const user = await User.create({
      name: 'Om',
      email: 'om@dawateislami.net',
      responsibility: 'Donation Box Incharge',
    });
    mockVerifyIdToken.mockResolvedValue(mockTicket({ email: 'om@dawateislami.net', email_verified: true }));

    const res = await request(app).post('/api/v1/auth/google').send({ idToken: 'good' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toEqual(expect.any(String));
    expect(res.body.data.user).toEqual({
      id: user.id,
      name: 'Om',
      email: 'om@dawateislami.net',
      role: 'user',
      responsibility: 'Donation Box Incharge',
    });
  });

  it('ignores spoofed extra fields (e.g. role, email) in the request body — identity only comes from the verified token', async () => {
    await User.create({ name: 'Om', email: 'om@dawateislami.net', responsibility: 'X', role: 'user' });
    mockVerifyIdToken.mockResolvedValue(mockTicket({ email: 'om@dawateislami.net', email_verified: true }));

    const res = await request(app)
      .post('/api/v1/auth/google')
      .send({ idToken: 'good', role: 'admin', email: 'someoneelse@dawateislami.net' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('user');
    expect(res.body.data.user.email).toBe('om@dawateislami.net');
  });

  it('rejects a missing idToken with VALIDATION_ERROR and field-level details', async () => {
    const res = await request(app).post('/api/v1/auth/google').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('rejects an unregistered email with USER_NOT_FOUND (403)', async () => {
    mockVerifyIdToken.mockResolvedValue(mockTicket({ email: 'ghost@dawateislami.net', email_verified: true }));
    const res = await request(app).post('/api/v1/auth/google').send({ idToken: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  it('rejects a deactivated user with USER_INACTIVE (403)', async () => {
    await User.create({ name: 'X', email: 'off@dawateislami.net', responsibility: 'X', isActive: false });
    mockVerifyIdToken.mockResolvedValue(mockTicket({ email: 'off@dawateislami.net', email_verified: true }));
    const res = await request(app).post('/api/v1/auth/google').send({ idToken: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('USER_INACTIVE');
  });

  it('rejects an invalid Google token with INVALID_TOKEN (400)', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('bad signature'));
    const res = await request(app).post('/api/v1/auth/google').send({ idToken: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  it('never leaks Google-library internals, stack traces, or the JWT secret in the error response', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('some internal google client library stack detail'));
    const res = await request(app).post('/api/v1/auth/google').send({ idToken: 'bad' });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/internal google client library stack detail/);
    expect(raw).not.toContain(env.JWT_SECRET);
    expect(raw).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // no stack-trace-shaped content
  });
});

describe('GET /api/v1/auth/me', () => {
  async function loginAs(email) {
    mockVerifyIdToken.mockResolvedValue(mockTicket({ email, email_verified: true }));
    const res = await request(app).post('/api/v1/auth/google').send({ idToken: 'x' });
    return res.body.data.token;
  }

  it('returns the authenticated user for a valid token', async () => {
    const user = await User.create({ name: 'Om', email: 'me@dawateislami.net', responsibility: 'X' });
    const token = await loginAs('me@dawateislami.net');

    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: user.id,
      name: 'Om',
      email: 'me@dawateislami.net',
      role: 'user',
      responsibility: 'X',
    });
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('rejects an invalid token', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer garbage');
    expect(res.status).toBe(401);
  });

  it('a client cannot impersonate another user — identity always comes from the verified token, never the request', async () => {
    const user = await User.create({ name: 'Real', email: 'real@dawateislami.net', responsibility: 'X' });
    const token = await loginAs('real@dawateislami.net');

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'someone-elses-id', role: 'admin' });

    expect(res.body.data.id).toBe(user.id);
    expect(res.body.data.role).toBe('user');
  });
});

describe('POST /api/v1/auth/dev-login (development/test only)', () => {
  it('logs in a seeded user without any Google verification', async () => {
    const user = await User.create({ name: 'Dev', email: 'dev@dawateislami.net', responsibility: 'X' });

    const res = await request(app).post('/api/v1/auth/dev-login').send({ email: 'dev@dawateislami.net' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user.id);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it('rejects an unregistered email the same way real login would', async () => {
    const res = await request(app).post('/api/v1/auth/dev-login').send({ email: 'nope@dawateislami.net' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  it('rejects a malformed email with VALIDATION_ERROR', async () => {
    const res = await request(app).post('/api/v1/auth/dev-login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
