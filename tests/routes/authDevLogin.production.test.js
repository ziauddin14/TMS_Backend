// Proves docs/12-testing.md §5's production-safety requirement at the strongest level available:
// the route itself must not exist in the Express router when NODE_ENV=production, not merely be
// rejected at request time. Uses jest.resetModules() + a forced process.env to get a genuinely
// fresh require of app.js under production configuration, isolated from every other test file.
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: jest.fn() })),
}));

const request = require('supertest');

describe('POST /auth/dev-login route registration under NODE_ENV=production', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    Object.assign(process.env, {
      NODE_ENV: 'production',
      PORT: '5000',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/irrelevant-never-connected-in-this-test',
      JWT_SECRET: 'production-test-secret-not-real-not-used-000000',
      JWT_EXPIRES_IN: '7d',
      GOOGLE_CLIENT_ID: 'prod-test-client-id.apps.googleusercontent.com',
      GOOGLE_ALLOWED_HD: '',
      GOOGLE_DRIVE_CLIENT_ID: 'prod-test-drive-client-id.apps.googleusercontent.com',
      GOOGLE_DRIVE_CLIENT_SECRET: 'prod-test-not-a-real-client-secret',
      GOOGLE_DRIVE_REFRESH_TOKEN: 'prod-test-not-a-real-refresh-token',
      GOOGLE_DRIVE_FOLDER_ID: 'prod-test-drive-folder-id',
      FRONTEND_URL: 'https://example.com',
      REMINDER_DAYS_BEFORE: '2',
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  it('is not registered at all — request falls through to the generic 404, not a dev-login-specific rejection', async () => {
    const app = require('../../src/app');

    const res = await request(app).post('/api/v1/auth/dev-login').send({ email: 'x@x.com' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('POST /auth/google and GET /auth/me remain registered and functional in production', async () => {
    const app = require('../../src/app');

    const googleRes = await request(app).post('/api/v1/auth/google').send({}); // fails validation, but proves the route exists (400, not 404)
    expect(googleRes.status).toBe(400);
    expect(googleRes.body.code).toBe('VALIDATION_ERROR');

    const meRes = await request(app).get('/api/v1/auth/me');
    expect(meRes.status).toBe(401); // exists and enforces auth, not 404
  });
});
