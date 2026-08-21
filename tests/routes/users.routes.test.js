const jwt = require('jsonwebtoken');
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

async function makeAdmin() {
  return User.create({ name: 'Admin', email: 'admin@dawateislami.net', responsibility: 'Admin', role: 'admin' });
}
async function makeUser(overrides = {}) {
  return User.create({
    name: 'User',
    email: `user${Math.random()}@dawateislami.net`,
    responsibility: 'X',
    role: 'user',
    ...overrides,
  });
}

describe('GET /api/v1/users', () => {
  it('rejects a non-Admin with FORBIDDEN_ROLE (403)', async () => {
    const user = await makeUser();
    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/users');
    expect(res.status).toBe(401);
  });

  it('lists users with pagination meta for an Admin', async () => {
    const admin = await makeAdmin();
    await makeUser();
    await makeUser();

    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${tokenFor(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3); // admin + 2 users
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 3 });
  });

  it('filters by role/isActive and searches, and rejects an unknown query param', async () => {
    const admin = await makeAdmin();
    await makeUser({ name: 'Findme', email: 'findme@dawateislami.net' });

    const res = await request(app)
      .get('/api/v1/users?role=user&search=findme')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].email).toBe('findme@dawateislami.net');

    const bad = await request(app)
      .get('/api/v1/users?bogus=1')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/users/:id', () => {
  it('an Admin can fetch any user', async () => {
    const admin = await makeAdmin();
    const target = await makeUser();
    const res = await request(app)
      .get(`/api/v1/users/${target.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(target.id);
  });

  it('a user can fetch their own record', async () => {
    const self = await makeUser();
    const res = await request(app)
      .get(`/api/v1/users/${self.id}`)
      .set('Authorization', `Bearer ${tokenFor(self)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(self.id);
  });

  it('a user requesting a colleague\'s id gets FORBIDDEN_ROLE (403)', async () => {
    const self = await makeUser();
    const colleague = await makeUser();
    const res = await request(app)
      .get(`/api/v1/users/${colleague.id}`)
      .set('Authorization', `Bearer ${tokenFor(self)}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  it('returns USER_NOT_FOUND_BY_ID (404) for an Admin requesting a nonexistent id', async () => {
    const admin = await makeAdmin();
    const mongoose = require('mongoose');
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .get(`/api/v1/users/${fakeId}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND_BY_ID');
  });
});

describe('POST /api/v1/users', () => {
  it('an Admin can create a user', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ name: 'New Person', email: 'new@dawateislami.net', responsibility: 'X', role: 'user' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'New Person',
      email: 'new@dawateislami.net',
      role: 'user',
      isActive: true,
    });
  });

  it('rejects a non-Admin with FORBIDDEN_ROLE', async () => {
    const user = await makeUser();
    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ name: 'X', email: 'x@dawateislami.net', responsibility: 'X', role: 'user' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  it('rejects a duplicate email with DUPLICATE_EMAIL (409)', async () => {
    const admin = await makeAdmin();
    await makeUser({ email: 'dup@dawateislami.net' });

    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ name: 'X', email: 'dup@dawateislami.net', responsibility: 'X', role: 'user' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_EMAIL');
  });

  it('rejects an invalid email / missing fields / bad role with VALIDATION_ERROR', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ name: '', email: 'not-an-email', responsibility: '', role: 'superadmin' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it('rejects an undocumented field (e.g. isActive) on create', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ name: 'X', email: 'x2@dawateislami.net', responsibility: 'X', role: 'user', isActive: false });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /api/v1/users/:id', () => {
  it('an Admin can update name/responsibility/role/isActive', async () => {
    const admin = await makeAdmin();
    const target = await makeUser();

    const res = await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ name: 'Renamed', isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Renamed', isActive: false });
  });

  it('rejects an attempt to change email with a clear validation error — does not silently ignore or accept it', async () => {
    const admin = await makeAdmin();
    const target = await makeUser({ email: 'original@dawateislami.net' });

    const res = await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ email: 'changed@dawateislami.net' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');

    const stillOriginal = await User.findById(target.id);
    expect(stillOriginal.email).toBe('original@dawateislami.net');
  });

  it('rejects a non-Admin with FORBIDDEN_ROLE', async () => {
    const user = await makeUser();
    const target = await makeUser();
    const res = await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ name: 'Hacked' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  it('returns USER_NOT_FOUND_BY_ID for a nonexistent id', async () => {
    const admin = await makeAdmin();
    const mongoose = require('mongoose');
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .patch(`/api/v1/users/${fakeId}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ name: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND_BY_ID');
  });

  it('there is no DELETE /users/:id route', async () => {
    const admin = await makeAdmin();
    const target = await makeUser();
    const res = await request(app)
      .delete(`/api/v1/users/${target.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(res.status).toBe(404); // falls through to the app's generic 404 — no such route exists
  });
});
