const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const Notification = require('../../src/models/Notification');
const pushService = require('../../src/services/push.service');
const reportService = require('../../src/services/report.service');
const { NOTIFICATION_TYPES } = require('../../src/utils/notificationTypes');

// Task receipt over HTTP: what POST /tasks starts, POST /tasks/:id/acknowledge, how GET /tasks shows
// it to an admin and to a user, the `receipt` filter (list, KPI summary and export alike), the
// reassign path, and the bell's view of it.

beforeAll(async () => connect());
beforeEach(() => {
  jest.spyOn(pushService, 'sendPushToUser').mockResolvedValue(undefined);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDatabase();
});
afterAll(async () => closeDatabase());

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
}
const auth = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });
let n = 0;
async function makeUser(overrides = {}) {
  n += 1;
  return User.create({ name: `User ${n}`, email: `u${n}-${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'user', ...overrides });
}
const makeAdmin = () => makeUser({ name: 'Admin', role: 'admin' });

async function createTask(admin, assignees, title = 'Task') {
  const res = await request(app)
    .post('/api/v1/tasks')
    .set(auth(admin))
    .send({ title, assignees: assignees.map((u) => u.id), responsibility: 'R', deadline: '2026-10-20' });
  expect(res.status).toBe(201);
  return res.body.data;
}
const acknowledge = (user, taskId) => request(app).post(`/api/v1/tasks/${taskId}/acknowledge`).set(auth(user));
const listIds = async (user, query = '') => {
  const res = await request(app).get(`/api/v1/tasks${query}`).set(auth(user));
  expect(res.status).toBe(200);
  return res.body.data.map((t) => t.codeNumber).sort();
};

// Four tasks for the filter tests: none confirmed, one of two confirmed, all confirmed, and an OLD
// task (no receipts) assigned to the same people.
async function filterFixture() {
  const admin = await makeAdmin();
  const [a, b] = [await makeUser(), await makeUser()];
  const none = await createTask(admin, [a, b], 'none');
  const partial = await createTask(admin, [a, b], 'partial');
  const all = await createTask(admin, [a, b], 'all');
  await acknowledge(a, partial.id).expect(200);
  await acknowledge(a, all.id).expect(200);
  await acknowledge(b, all.id).expect(200);
  const old = await Task.create({ codeNumber: '250099', title: 'old', assignees: [a._id, b._id], responsibility: 'R', deadline: new Date('2026-10-20'), createdBy: admin._id });
  return { admin, a, b, none, partial, all, old };
}

describe('POST /api/v1/tasks — task receipt', () => {
  it('the created task carries one receipt per assignee, and each gets the assignment notice', async () => {
    const admin = await makeAdmin();
    const [a, b] = [await makeUser({ name: 'زید' }), await makeUser({ name: 'عمر' })];

    const task = await createTask(admin, [a, b]);

    expect(task.receipt).toMatchObject({ required: 2, acknowledged: 0 });
    expect(task.receipt.people.map((p) => p.user.name)).toEqual(['زید', 'عمر']);
    task.receipt.people.forEach((p) => {
      expect(p.acknowledgedAt).toBeNull();
      expect(p.remindersSent).toBe(0);
    });
    expect(task.myReceipt).toBeNull();
    expect(await Notification.countDocuments({ type: NOTIFICATION_TYPES.TASK_ASSIGNED, taskId: task.id })).toBe(2);
  });
});

describe('POST /api/v1/tasks/:id/acknowledge', () => {
  it('the assignee confirms; the response shows their own receipt; a second call changes nothing', async () => {
    const admin = await makeAdmin();
    const a = await makeUser();
    const task = await createTask(admin, [a]);

    const first = await acknowledge(a, task.id);
    expect(first.status).toBe(200);
    expect(first.body.data.myReceipt.acknowledgedAt).toBeTruthy();
    expect(first.body.data.receipt).toBeNull();

    const second = await acknowledge(a, task.id);
    expect(second.status).toBe(200);
    expect(second.body.data.myReceipt.acknowledgedAt).toBe(first.body.data.myReceipt.acknowledgedAt);
  });

  it('nobody else can confirm it: another user 403, an admin 403', async () => {
    const admin = await makeAdmin();
    const [a, other] = [await makeUser(), await makeUser()];
    const task = await createTask(admin, [a]);

    expect((await acknowledge(other, task.id)).body.code).toBe('FORBIDDEN_NOT_ASSIGNEE');
    expect((await acknowledge(admin, task.id)).status).toBe(403);
    const stored = await Task.findById(task.id);
    expect(stored.receipts[0].acknowledgedAt).toBeNull();
  });

  it('takes no body — a user id cannot be passed in to confirm for someone else', async () => {
    const admin = await makeAdmin();
    const [a, b] = [await makeUser(), await makeUser()];
    const task = await createTask(admin, [a, b]);
    const res = await request(app).post(`/api/v1/tasks/${task.id}/acknowledge`).set(auth(a)).send({ userId: b.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('requires a session', async () => {
    const res = await request(app).post(`/api/v1/tasks/${new mongoose.Types.ObjectId()}/acknowledge`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/tasks — who sees what of a receipt', () => {
  it('an admin sees the count and every person; a user sees only their own receipt', async () => {
    const admin = await makeAdmin();
    const [a, b] = [await makeUser(), await makeUser()];
    const task = await createTask(admin, [a, b]);
    await acknowledge(a, task.id).expect(200);

    const asAdmin = (await request(app).get('/api/v1/tasks').set(auth(admin))).body.data[0];
    expect(asAdmin.receipt).toMatchObject({ required: 2, acknowledged: 1 });
    expect(asAdmin.myReceipt).toBeNull();

    const asA = (await request(app).get('/api/v1/tasks').set(auth(a))).body.data[0];
    expect(asA.receipt).toBeNull();
    expect(asA.myReceipt.acknowledgedAt).toBeTruthy();
    const asB = (await request(app).get(`/api/v1/tasks/${task.id}`).set(auth(b))).body.data;
    expect(asB.receipt).toBeNull();
    expect(asB.myReceipt).toEqual({ assignedAt: expect.any(String), acknowledgedAt: null });
  });

  it('an OLD task shows no receipt to anyone', async () => {
    const admin = await makeAdmin();
    const a = await makeUser();
    await Task.create({ codeNumber: '250098', title: 'old', assignees: [a._id], responsibility: 'R', deadline: new Date(), createdBy: admin._id });

    const asAdmin = (await request(app).get('/api/v1/tasks').set(auth(admin))).body.data[0];
    const asUser = (await request(app).get('/api/v1/tasks').set(auth(a))).body.data[0];
    expect([asAdmin.receipt, asAdmin.myReceipt, asUser.receipt, asUser.myReceipt]).toEqual([null, null, null, null]);
  });
});

describe('the `receipt` filter — list, KPI summary and export follow it alike', () => {
  it('admin: received = all confirmed, not_received = none confirmed, partial = some; an old task matches none of them', async () => {
    const { admin, none, partial, all } = await filterFixture();

    expect(await listIds(admin, '?receipt=received')).toEqual([all.codeNumber]);
    expect(await listIds(admin, '?receipt=not_received')).toEqual([none.codeNumber]);
    expect(await listIds(admin, '?receipt=partial')).toEqual([partial.codeNumber]);
    expect(await listIds(admin)).toHaveLength(4);
  });

  it('user: received / not_received go by their OWN receipt; partial (other people\'s state) matches nothing', async () => {
    const { b, none, partial, all } = await filterFixture();

    expect(await listIds(b, '?receipt=received')).toEqual([all.codeNumber]);
    expect(await listIds(b, '?receipt=not_received')).toEqual([none.codeNumber, partial.codeNumber].sort());
    expect(await listIds(b, '?receipt=partial')).toEqual([]);
  });

  it('combines with the other filters', async () => {
    const { admin, none, partial } = await filterFixture();
    await Task.updateOne({ _id: partial.id }, { $set: { status: 'pending' } });
    expect(await listIds(admin, '?receipt=partial&status=pending')).toEqual([partial.codeNumber]);
    expect(await listIds(admin, '?receipt=not_received&status=pending')).toEqual([]);
    expect(await listIds(admin, `?receipt=not_received&search=${none.codeNumber}`)).toEqual([none.codeNumber]);
  });

  it('the KPI summary follows it (for an admin and for a user)', async () => {
    const { admin, b } = await filterFixture();
    const total = async (user, query) => (await request(app).get(`/api/v1/dashboard/summary${query}`).set(auth(user))).body.data.total;

    expect(await total(admin, '')).toBe(4);
    expect(await total(admin, '?receipt=received')).toBe(1);
    expect(await total(admin, '?receipt=not_received')).toBe(1);
    expect(await total(admin, '?receipt=partial')).toBe(1);
    expect(await total(b, '?receipt=not_received')).toBe(2);
  });

  it('the export follows it', async () => {
    const { admin, none } = await filterFixture();
    const report = await reportService.buildReportData({ id: admin.id, role: 'admin' }, { receipt: 'not_received' });
    const codes = report.groups.flatMap((group) => group.tasks.map((entry) => entry.task.codeNumber));
    expect([...new Set(codes)]).toEqual([none.codeNumber]);
    expect(reportService.buildHeaderInfo({ name: 'Admin', responsibility: 'R' }, { receipt: 'not_received' }).filterDescription).toContain(
      'Receipt: Not received'
    );
  });

  it('rejects an unknown value', async () => {
    const admin = await makeAdmin();
    const res = await request(app).get('/api/v1/tasks?receipt=maybe').set(auth(admin));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/v1/tasks/:id — reassign', () => {
  it('the new assignee gets a receipt and the notice; the old one\'s receipt no longer counts', async () => {
    const admin = await makeAdmin();
    const [a, b] = [await makeUser(), await makeUser({ name: 'نیا ذمہ دار' })];
    const task = await createTask(admin, [a]);

    const res = await request(app).patch(`/api/v1/tasks/${task.id}`).set(auth(admin)).send({ assignees: [b.id] });

    expect(res.status).toBe(200);
    expect(res.body.data.receipt.required).toBe(1);
    expect(res.body.data.receipt.people.map((p) => p.user.name)).toEqual(['نیا ذمہ دار']);
    expect(await Notification.countDocuments({ type: NOTIFICATION_TYPES.TASK_ASSIGNED, recipientUserId: b._id })).toBe(1);
    expect(await Notification.countDocuments({ type: NOTIFICATION_TYPES.TASK_ASSIGNED, recipientUserId: a._id })).toBe(1);
  });
});

describe('GET /api/v1/notifications — the bell sees the current receipt state', () => {
  it('canAcknowledge until confirmed, then acknowledgedAt; other notifications carry receipt: null', async () => {
    const admin = await makeAdmin();
    const a = await makeUser();
    const task = await createTask(admin, [a]);
    await request(app).post('/api/v1/admin/notifications').set(auth(admin)).send({ recipientType: 'user', userId: a.id, message: 'hello' }).expect(201);

    const list = async () => (await request(app).get('/api/v1/notifications').set(auth(a))).body.data;
    let items = await list();
    const notice = () => items.find((item) => item.type === NOTIFICATION_TYPES.TASK_ASSIGNED);
    expect(notice().receipt).toEqual({ acknowledgedAt: null, canAcknowledge: true });
    expect(notice().isRead).toBe(false);
    expect(items.find((item) => item.type === NOTIFICATION_TYPES.USER_REMINDER).receipt).toBeNull();

    await acknowledge(a, task.id).expect(200);
    items = await list();
    expect(notice().receipt.canAcknowledge).toBe(false);
    expect(notice().receipt.acknowledgedAt).toBeTruthy();
    expect(notice().isRead).toBe(true);
  });
});
