const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const LookupList = require('../../src/models/LookupList');
const Task = require('../../src/models/Task');

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

describe('POST /api/v1/tasks', () => {
  it('an Admin can create a task', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();

    const res = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'New Task', assignees: [assignee.id], responsibility: lookup.value, deadline: inDays(3) });

    expect(res.status).toBe(201);
    expect(res.body.data.codeNumber).toMatch(/^\d{6}$/);
    expect(res.body.data.status).toBe('ongoing');
    expect(res.body.data.assignees[0]).toMatchObject({ id: assignee.id, name: assignee.name });
  });

  it('rejects a non-Admin with FORBIDDEN_ROLE', async () => {
    const user = await makeUser();
    const lookup = await makeLookup();
    const res = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ title: 'X', assignees: [user.id], responsibility: lookup.value, deadline: inDays(1) });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/v1/tasks').send({});
    expect(res.status).toBe(401);
  });

  it('rejects missing/empty fields with VALIDATION_ERROR', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: '', assignees: [], responsibility: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an invalid assignee id with VALIDATION_ERROR and details', async () => {
    const admin = await makeAdmin();
    const lookup = await makeLookup();
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'X', assignees: [fakeId], responsibility: lookup.value, deadline: inDays(1) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details[0].field).toBe('assignees');
  });

  it('rejects an unrecognized responsibility value', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const res = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'X', assignees: [assignee.id], responsibility: 'Nonexistent', deadline: inDays(1) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/tasks (scoping and filters)', () => {
  it('a User can never see another user\'s tasks, even passing a different assigneeId in the query', async () => {
    const admin = await makeAdmin();
    const me = await makeUser();
    const other = await makeUser();
    const lookup = await makeLookup();

    await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'Mine', assignees: [me.id], responsibility: lookup.value, deadline: inDays(1) });
    await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'Not mine', assignees: [other.id], responsibility: lookup.value, deadline: inDays(1) });

    const res = await request(app)
      .get(`/api/v1/tasks?assigneeId=${other.id}`)
      .set('Authorization', `Bearer ${tokenFor(me)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('Mine');
  });

  it('an Admin sees all tasks and can filter by assigneeId', async () => {
    const admin = await makeAdmin();
    const target = await makeUser();
    const lookup = await makeLookup();
    await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'X', assignees: [target.id], responsibility: lookup.value, deadline: inDays(1) });

    const res = await request(app)
      .get(`/api/v1/tasks?assigneeId=${target.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 1 });
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(401);
  });

  it('rejects an unknown query param', async () => {
    const user = await makeUser();
    const res = await request(app).get('/api/v1/tasks?bogus=1').set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/tasks/:id', () => {
  it('an assigned User can fetch the task; a non-assigned User is rejected', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const outsider = await makeUser();
    const lookup = await makeLookup();
    const createRes = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'X', assignees: [assignee.id], responsibility: lookup.value, deadline: inDays(1) });
    const taskId = createRes.body.data.id;

    const okRes = await request(app)
      .get(`/api/v1/tasks/${taskId}`)
      .set('Authorization', `Bearer ${tokenFor(assignee)}`);
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.id).toBe(taskId);

    const forbiddenRes = await request(app)
      .get(`/api/v1/tasks/${taskId}`)
      .set('Authorization', `Bearer ${tokenFor(outsider)}`);
    expect(forbiddenRes.status).toBe(403);
    expect(forbiddenRes.body.code).toBe('FORBIDDEN_NOT_ASSIGNEE');
  });

  it('returns TASK_NOT_FOUND (404) for a nonexistent id, as Admin', async () => {
    const admin = await makeAdmin();
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .get(`/api/v1/tasks/${fakeId}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });
});

describe('PATCH /api/v1/tasks/:id', () => {
  it('an Admin can edit allowed fields; changing deadline visibly updates timeStatus in the same response', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const createRes = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'Original', assignees: [assignee.id], responsibility: lookup.value, deadline: inDays(1) });
    const taskId = createRes.body.data.id;
    const originalDays = createRes.body.data.timeStatus.days;

    const res = await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'Updated', deadline: inDays(15) });

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Updated');
    expect(res.body.data.timeStatus.days).toBeGreaterThan(originalDays);
    expect(res.body.data.status).toBe('ongoing'); // untouched
  });

  it('rejects a non-Admin with FORBIDDEN_ROLE', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const createRes = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'X', assignees: [assignee.id], responsibility: lookup.value, deadline: inDays(1) });

    const res = await request(app)
      .patch(`/api/v1/tasks/${createRes.body.data.id}`)
      .set('Authorization', `Bearer ${tokenFor(assignee)}`)
      .send({ title: 'Hacked' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  it('rejects an undocumented field (e.g. status)', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const createRes = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'X', assignees: [assignee.id], responsibility: lookup.value, deadline: inDays(1) });

    const res = await request(app)
      .patch(`/api/v1/tasks/${createRes.body.data.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ status: 'closed' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns TASK_NOT_FOUND for a nonexistent id', async () => {
    const admin = await makeAdmin();
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .patch(`/api/v1/tasks/${fakeId}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });

  it('there is no DELETE /tasks/:id route', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const createRes = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'X', assignees: [assignee.id], responsibility: lookup.value, deadline: inDays(1) });

    const res = await request(app)
      .delete(`/api/v1/tasks/${createRes.body.data.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(res.status).toBe(404); // no such route at all
  });
});

describe('PATCH /api/v1/tasks/:id/close', () => {
  it('an Admin can close a task, and a task closed at 40% with zero updates still gets a real performanceRating', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const createRes = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'X', assignees: [assignee.id], responsibility: lookup.value, deadline: inDays(-1) });
    const taskId = createRes.body.data.id;
    await Task.findByIdAndUpdate(taskId, { completionPercent: 40 });

    const res = await request(app)
      .patch(`/api/v1/tasks/${taskId}/close`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('closed');
    expect(res.body.data.closedBy).toBe(admin.id);
    expect(res.body.data.closedAt).not.toBeNull();
    expect(res.body.data.performanceRating).toBe('weak');
  });

  it('rejects a non-Admin with FORBIDDEN_ROLE', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const createRes = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'X', assignees: [assignee.id], responsibility: lookup.value, deadline: inDays(1) });

    const res = await request(app)
      .patch(`/api/v1/tasks/${createRes.body.data.id}/close`)
      .set('Authorization', `Bearer ${tokenFor(assignee)}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  it('returns TASK_NOT_FOUND for a nonexistent id', async () => {
    const admin = await makeAdmin();
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .patch(`/api/v1/tasks/${fakeId}/close`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });
});
