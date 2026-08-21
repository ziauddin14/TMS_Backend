// Isolated in its own file/app instance so the request count isn't shared with other auth route
// tests (express-rate-limit's counter lives for the lifetime of the middleware instance, which is
// created once per fresh require of auth.routes.js).
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('irrelevant for this test')),
  })),
}));

const request = require('supertest');
const app = require('../../src/app');

describe('POST /api/v1/auth/google rate limiting (docs/03-backend-foundation.md §6)', () => {
  it('allows up to the documented 20 requests / 15 minutes, then rejects further ones with RATE_LIMITED (429)', async () => {
    for (let i = 0; i < 20; i += 1) {
      const res = await request(app).post('/api/v1/auth/google').send({ idToken: 'x' });
      expect(res.status).not.toBe(429);
    }

    const blocked = await request(app).post('/api/v1/auth/google').send({ idToken: 'x' });

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      success: false,
      message: expect.any(String),
      code: 'RATE_LIMITED',
    });
  }, 30000);

  it('does not rate-limit an unrelated endpoint (GET /health)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
