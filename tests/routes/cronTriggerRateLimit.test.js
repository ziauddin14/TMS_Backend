// Isolated in its own file/app instance (mirrors tests/routes/authRateLimit.test.js exactly) so
// this file's 11 requests — enough to exhaust the limiter — never share a counter with, or push
// past the limit in, any other test file that also calls POST /admin/trigger-reminders.
const request = require('supertest');
const app = require('../../src/app');

describe('POST /api/v1/admin/trigger-reminders rate limiting (X-Cron-Secret brute-force defense)', () => {
  it('allows up to 10 requests / 15 minutes, then rejects further ones with RATE_LIMITED (429)', async () => {
    // A wrong secret on every call — the rate limiter runs before the secret check, so this
    // exercises the limiter itself without needing 10+ real reminder-engine scans.
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app)
        .post('/api/v1/admin/trigger-reminders')
        .set('X-Cron-Secret', 'wrong-secret');
      expect(res.status).not.toBe(429);
    }

    const blocked = await request(app)
      .post('/api/v1/admin/trigger-reminders')
      .set('X-Cron-Secret', 'wrong-secret');

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
