// Isolated in its own file (mirrors tests/routes/authRateLimit.test.js's own reasoning) so this
// file's handful of real POST /admin/trigger-reminders calls never share a rate-limiter counter,
// or accumulate trigger-reminders call counts, with adminNotifications.routes.test.js's own
// Phase 2/3 tests against the same route.
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
}
async function makeAdmin(overrides = {}) {
  return User.create({ name: 'Admin', email: `admin${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'Admin', role: 'admin', ...overrides });
}
async function makeUser(overrides = {}) {
  return User.create({ name: 'User', email: `user${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'X', role: 'user', isActive: true, ...overrides });
}

describe('POST /api/v1/admin/trigger-reminders — X-Cron-Secret dual auth (GitHub Actions cron)', () => {
  it('a correct X-Cron-Secret header succeeds with NO Authorization header at all', async () => {
    const res = await request(app)
      .post('/api/v1/admin/trigger-reminders')
      .set('X-Cron-Secret', env.CRON_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('remindersSent');
  });

  it('a wrong X-Cron-Secret header is a clean 401 — no Authorization header present either', async () => {
    const res = await request(app)
      .post('/api/v1/admin/trigger-reminders')
      .set('X-Cron-Secret', 'this-is-not-the-real-secret');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CRON_SECRET');
  });

  it('a wrong X-Cron-Secret header is still 401 even alongside a VALID Admin JWT — no silent fallback to the JWT flow', async () => {
    const admin = await makeAdmin();

    const res = await request(app)
      .post('/api/v1/admin/trigger-reminders')
      .set('X-Cron-Secret', 'this-is-not-the-real-secret')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CRON_SECRET'); // proves the JWT path was never reached
  });

  it('no X-Cron-Secret header at all + a valid Admin JWT -> succeeds exactly as before (existing path unaffected)', async () => {
    const admin = await makeAdmin();

    const res = await request(app)
      .post('/api/v1/admin/trigger-reminders')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('remindersSent');
  });

  it('no X-Cron-Secret header and no Authorization header at all -> the ordinary 401 UNAUTHORIZED (unchanged)', async () => {
    const res = await request(app).post('/api/v1/admin/trigger-reminders');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('no X-Cron-Secret header + a valid JWT for a non-admin user -> the ordinary 403 FORBIDDEN_ROLE (unchanged)', async () => {
    const user = await makeUser();

    const res = await request(app)
      .post('/api/v1/admin/trigger-reminders')
      .set('Authorization', `Bearer ${tokenFor(user)}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });
});
