const request = require('supertest');
const app = require('../src/app');

describe('GET /health', () => {
  it('returns 200 with status ok, uptime, and timestamp', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.timestamp).toBe('string');
  });
});
