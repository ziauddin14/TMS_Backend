const request = require('supertest');
const app = require('../src/app');

describe('404 handler', () => {
  it('returns the standardized error shape for an unknown route', async () => {
    const res = await request(app).get('/this-route-does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      message: 'Route not found',
      code: 'NOT_FOUND',
    });
  });
});
