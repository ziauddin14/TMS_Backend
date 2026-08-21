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
  return User.create({ name: 'Admin', email: 'admin@dawateislami.net', responsibility: 'Admin', role: 'admin' });
}
async function makeUser() {
  return User.create({
    name: 'User',
    email: `user${Math.random()}@dawateislami.net`,
    responsibility: 'X',
    role: 'user',
  });
}

describe('GET /api/v1/lookup-lists', () => {
  it('is accessible to any authenticated role (not Admin-only)', async () => {
    const user = await makeUser();
    await LookupList.create({ listType: 'responsibility', value: 'Donation Box Incharge' });

    const res = await request(app)
      .get('/api/v1/lookup-lists?type=responsibility')
      .set('Authorization', `Bearer ${tokenFor(user)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/lookup-lists?type=responsibility');
    expect(res.status).toBe(401);
  });

  it('requires the type query param', async () => {
    const user = await makeUser();
    const res = await request(app).get('/api/v1/lookup-lists').set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a listType outside the documented enum', async () => {
    const user = await makeUser();
    const res = await request(app)
      .get('/api/v1/lookup-lists?type=zimmedar')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(res.status).toBe(400);
  });

  it('excludes deactivated values', async () => {
    const user = await makeUser();
    await LookupList.create({ listType: 'responsibility', value: 'Active One' });
    await LookupList.create({ listType: 'responsibility', value: 'Retired One', isActive: false });

    const res = await request(app)
      .get('/api/v1/lookup-lists?type=responsibility')
      .set('Authorization', `Bearer ${tokenFor(user)}`);

    expect(res.body.data.map((d) => d.value)).toEqual(['Active One']);
  });
});

describe('POST /api/v1/lookup-lists', () => {
  it('an Admin can add a value', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/v1/lookup-lists')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ listType: 'responsibility', value: 'New Role', sortOrder: 3 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ listType: 'responsibility', value: 'New Role', sortOrder: 3 });
  });

  it('rejects a non-Admin with FORBIDDEN_ROLE', async () => {
    const user = await makeUser();
    const res = await request(app)
      .post('/api/v1/lookup-lists')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ listType: 'responsibility', value: 'X' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  it('rejects a duplicate (listType, value) with DUPLICATE_LOOKUP_VALUE (409)', async () => {
    const admin = await makeAdmin();
    await LookupList.create({ listType: 'responsibility', value: 'Existing' });

    const res = await request(app)
      .post('/api/v1/lookup-lists')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ listType: 'responsibility', value: 'Existing' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_LOOKUP_VALUE');
  });
});

describe('PATCH /api/v1/lookup-lists/:id', () => {
  it('an Admin can retire a value via isActive:false without deleting it', async () => {
    const admin = await makeAdmin();
    const entry = await LookupList.create({ listType: 'responsibility', value: 'Retire Me' });

    const res = await request(app)
      .patch(`/api/v1/lookup-lists/${entry.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);

    const stillThere = await LookupList.findById(entry.id);
    expect(stillThere).not.toBeNull();
  });

  it('rejects a non-Admin with FORBIDDEN_ROLE', async () => {
    const user = await makeUser();
    const entry = await LookupList.create({ listType: 'responsibility', value: 'X' });
    const res = await request(app)
      .patch(`/api/v1/lookup-lists/${entry.id}`)
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ isActive: false });
    expect(res.status).toBe(403);
  });

  it('returns LOOKUP_NOT_FOUND for a nonexistent id', async () => {
    const admin = await makeAdmin();
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .patch(`/api/v1/lookup-lists/${fakeId}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ isActive: false });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('LOOKUP_NOT_FOUND');
  });
});
