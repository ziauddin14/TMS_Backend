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
async function createTaskViaApi(admin, assigneeIds) {
  const lookup = await makeLookup();
  const res = await request(app)
    .post('/api/v1/tasks')
    .set('Authorization', `Bearer ${tokenFor(admin)}`)
    .send({ title: 'Task', assignees: assigneeIds, responsibility: lookup.value, deadline: inDays(5) });
  return res.body.data.id;
}

describe('POST /api/v1/tasks/:id/updates', () => {
  it('an assignee can post an update; response contains both the update and the recalculated task', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const taskId = await createTaskViaApi(admin, [assignee.id]);

    const res = await request(app)
      .post(`/api/v1/tasks/${taskId}/updates`)
      .set('Authorization', `Bearer ${tokenFor(assignee)}`)
      .send({ description: 'Progress update', completionPercent: 55 });

    expect(res.status).toBe(201);
    expect(res.body.data.update).toMatchObject({ description: 'Progress update', completionPercent: 55 });
    expect(res.body.data.update.updatedBy).toMatchObject({ id: assignee.id, name: assignee.name });
    expect(res.body.data.task).toMatchObject({ id: taskId, completionPercent: 55, status: 'ongoing' });

    const getRes = await request(app).get(`/api/v1/tasks/${taskId}`).set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(getRes.body.data.completionPercent).toBe(55);
  });

  it('rejects a non-assignee User with FORBIDDEN_NOT_ASSIGNEE', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const outsider = await makeUser();
    const taskId = await createTaskViaApi(admin, [assignee.id]);

    const res = await request(app)
      .post(`/api/v1/tasks/${taskId}/updates`)
      .set('Authorization', `Bearer ${tokenFor(outsider)}`)
      .send({ description: 'Not allowed', completionPercent: 10 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_NOT_ASSIGNEE');
  });

  it('rejects an update on a closed task', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const taskId = await createTaskViaApi(admin, [assignee.id]);
    await request(app).patch(`/api/v1/tasks/${taskId}/close`).set('Authorization', `Bearer ${tokenFor(admin)}`);

    const res = await request(app)
      .post(`/api/v1/tasks/${taskId}/updates`)
      .set('Authorization', `Bearer ${tokenFor(assignee)}`)
      .send({ description: 'Too late', completionPercent: 10 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toBe('Yeh kaam close ho chuka hai');
  });

  it('rejects missing/invalid fields with VALIDATION_ERROR', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const taskId = await createTaskViaApi(admin, [assignee.id]);

    const res = await request(app)
      .post(`/api/v1/tasks/${taskId}/updates`)
      .set('Authorization', `Bearer ${tokenFor(assignee)}`)
      .send({ description: '', completionPercent: 150 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unauthenticated request', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const taskId = await createTaskViaApi(admin, [assignee.id]);

    const res = await request(app).post(`/api/v1/tasks/${taskId}/updates`).send({ description: 'X', completionPercent: 10 });
    expect(res.status).toBe(401);
  });

  it('returns TASK_NOT_FOUND for a nonexistent task id', async () => {
    const assignee = await makeUser();
    const fakeId = new mongoose.Types.ObjectId().toString();

    const res = await request(app)
      .post(`/api/v1/tasks/${fakeId}/updates`)
      .set('Authorization', `Bearer ${tokenFor(assignee)}`)
      .send({ description: 'X', completionPercent: 10 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });
});

describe('GET /api/v1/tasks/:id/updates', () => {
  it('an assignee can list update history, newest first', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const taskId = await createTaskViaApi(admin, [assignee.id]);

    await request(app)
      .post(`/api/v1/tasks/${taskId}/updates`)
      .set('Authorization', `Bearer ${tokenFor(assignee)}`)
      .send({ description: 'First', completionPercent: 20 });
    await request(app)
      .post(`/api/v1/tasks/${taskId}/updates`)
      .set('Authorization', `Bearer ${tokenFor(assignee)}`)
      .send({ description: 'Second', completionPercent: 40 });

    const res = await request(app)
      .get(`/api/v1/tasks/${taskId}/updates`)
      .set('Authorization', `Bearer ${tokenFor(assignee)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].description).toBe('Second'); // newest first
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 2 });
  });

  it('rejects a non-assignee User', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const outsider = await makeUser();
    const taskId = await createTaskViaApi(admin, [assignee.id]);

    const res = await request(app)
      .get(`/api/v1/tasks/${taskId}/updates`)
      .set('Authorization', `Bearer ${tokenFor(outsider)}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_NOT_ASSIGNEE');
  });

  it('rejects an unauthenticated request', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const taskId = await createTaskViaApi(admin, [assignee.id]);

    const res = await request(app).get(`/api/v1/tasks/${taskId}/updates`);
    expect(res.status).toBe(401);
  });
});
