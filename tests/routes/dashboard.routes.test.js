const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const LookupList = require('../../src/models/LookupList');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
}
async function makeAdmin() {
  return User.create({ name: 'Admin', email: `admin${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'Admin', role: 'admin' });
}
async function makeUser(overrides = {}) {
  return User.create({
    name: 'User',
    email: `user${new mongoose.Types.ObjectId()}@x.com`,
    responsibility: 'X',
    role: 'user',
    ...overrides,
  });
}
async function makeLookup(value = 'Donation Box Incharge') {
  return LookupList.create({ listType: 'responsibility', value });
}
function inDays(n) {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

describe('GET /api/v1/dashboard/summary', () => {
  it('matches the documented response envelope and shape', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'X', assignees: [assignee.id], responsibility: lookup.value, deadline: inDays(5) });

    const res = await request(app).get('/api/v1/dashboard/summary').set('Authorization', `Bearer ${tokenFor(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        byStatus: {
          ongoing: { count: 1, percent: 100 },
          pending: { count: 0, percent: 0 },
          complete: { count: 0, percent: 0 },
          closed: { count: 0, percent: 0 },
        },
        byPerformance: {
          excellent: { count: 0, percent: 0 },
          good: { count: 0, percent: 0 },
          fair: { count: 0, percent: 0 },
          weak: { count: 0, percent: 0 },
          notApplicable: { count: 1, percent: 100 },
        },
        total: 1,
      },
    });
  });

  it("scopes a User's summary to only their own tasks, distinct from another user's", async () => {
    const admin = await makeAdmin();
    const me = await makeUser();
    const other = await makeUser();
    const lookup = await makeLookup();
    await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'Mine', assignees: [me.id], responsibility: lookup.value, deadline: inDays(5) });
    await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'Not mine', assignees: [other.id], responsibility: lookup.value, deadline: inDays(5) });

    const res = await request(app).get('/api/v1/dashboard/summary').set('Authorization', `Bearer ${tokenFor(me)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/dashboard/summary');
    expect(res.status).toBe(401);
  });
});
