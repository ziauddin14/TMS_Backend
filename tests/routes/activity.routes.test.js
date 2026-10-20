const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const ActivityEvent = require('../../src/models/ActivityEvent');
const AppSetting = require('../../src/models/AppSetting');
const LookupList = require('../../src/models/LookupList');
const activityService = require('../../src/services/activity.service');
const appSettingService = require('../../src/services/appSetting.service');
const pushService = require('../../src/services/push.service');
const taskService = require('../../src/services/task.service');

// The activity log over HTTP: the admin endpoints (and their 403s), the settings, login / logout,
// every action hook, and the requests that must NOT count as activity.

beforeAll(async () => connect());
beforeEach(() => {
  jest.spyOn(pushService, 'sendPushToUser').mockResolvedValue(undefined);
});
afterEach(async () => {
  jest.restoreAllMocks();
  mockVerifyIdToken.mockReset();
  await activityService.flushForTests();
  await clearDatabase();
  appSettingService.resetCacheForTests();
});
afterAll(async () => closeDatabase());

const UA = 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
}
const as = (user) => ({ Authorization: `Bearer ${tokenFor(user)}`, 'User-Agent': UA });
let n = 0;
async function makeUser(overrides = {}) {
  n += 1;
  return User.create({ name: `User ${n}`, email: `u${n}-${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'user', ...overrides });
}
const makeAdmin = () => makeUser({ role: 'admin', name: 'Admin' });
async function events(type) {
  await activityService.flushForTests();
  return ActivityEvent.find(type ? { type } : {}).sort({ at: 1 }).lean();
}
const rawUser = (user) => User.collection.findOne({ _id: user._id });
async function makeTask(admin, assignees) {
  return taskService.createTask({ id: admin.id, role: 'admin', name: admin.name }, { title: 'T', assignees: assignees.map((u) => u.id), responsibility: 'R', deadline: new Date(Date.now() + 7 * 86400000) }, { withReceipts: true });
}

describe('admin endpoints — Admin only', () => {
  it.each([
    ['get', '/api/v1/admin/activity/summary'],
    ['get', '/api/v1/admin/activity/users'],
    ['get', `/api/v1/admin/activity/users/${new mongoose.Types.ObjectId()}/events`],
    ['get', `/api/v1/admin/activity/users/${new mongoose.Types.ObjectId()}/history`],
    ['get', '/api/v1/admin/settings/activity'],
    ['patch', '/api/v1/admin/settings/activity'],
  ])('%s %s is 403 for a normal user', async (method, url) => {
    const user = await makeUser();
    const res = await request(app)[method](url).set(as(user)).send({ inactivityDays: 10 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  it('summary, users list, events and history answer an Admin', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const summary = await request(app).get('/api/v1/admin/activity/summary').set(as(admin));
    expect(summary.status).toBe(200);
    expect(summary.body.data).toMatchObject({ inactivityDays: 7, inactiveCount: 0, totalActive: 2 });

    const list = await request(app).get('/api/v1/admin/activity/users?search=User').set(as(admin));
    expect(list.status).toBe(200);
    expect(list.body.data.map((row) => row.id)).toContain(user.id);

    expect((await request(app).get(`/api/v1/admin/activity/users/${user.id}/events`).set(as(admin))).status).toBe(200);
    expect((await request(app).get(`/api/v1/admin/activity/users/${user.id}/history`).set(as(admin))).status).toBe(200);
    expect((await request(app).get('/api/v1/admin/activity/users/nope/events').set(as(admin))).status).toBe(404);
    expect((await request(app).get(`/api/v1/admin/activity/users/${user.id}/events?type=NOPE`).set(as(admin))).status).toBe(400);
  });
});

describe('settings — inactivity days', () => {
  it('7 by default; an Admin can set a whole number from 1 to 90, and the change is logged', async () => {
    const admin = await makeAdmin();
    expect((await request(app).get('/api/v1/admin/settings/activity').set(as(admin))).body.data).toMatchObject({
      inactivityDays: 7,
      minInactivityDays: 1,
      maxInactivityDays: 90,
    });

    const res = await request(app).patch('/api/v1/admin/settings/activity').set(as(admin)).send({ inactivityDays: 14 });
    expect(res.status).toBe(200);
    expect(res.body.data.inactivityDays).toBe(14);
    const [event] = await events('SETTINGS_CHANGED');
    expect(event.metadata).toEqual({ setting: 'inactivityDays', from: 7, to: 14 });
  });

  it.each([0, 91, 7.5, '10', null])('rejects %p', async (value) => {
    const admin = await makeAdmin();
    const res = await request(app).patch('/api/v1/admin/settings/activity').set(as(admin)).send({ inactivityDays: value });
    expect(res.status).toBe(400);
    expect(await AppSetting.countDocuments({ key: 'inactivityDays' })).toBe(0);
  });
});

describe('login, logout, and what counts as activity', () => {
  it('a Google sign-in records LOGIN (with the device) and sets last login and last active', async () => {
    const user = await makeUser({ email: 'person@dawateislami.net' });
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ email: 'person@dawateislami.net', email_verified: true }) });

    await request(app).post('/api/v1/auth/google').set('User-Agent', UA).send({ idToken: 'good' }).expect(200);

    const [login] = await events('LOGIN');
    expect(String(login.user)).toBe(user.id);
    expect(login.device).toEqual({ browser: 'Chrome', os: 'Android', deviceType: 'mobile' });
    const stored = await rawUser(user);
    expect(stored.lastLoginAt).toBeInstanceOf(Date);
    expect(stored.lastActiveAt).toBeInstanceOf(Date);
  });

  it('a failed sign-in records nothing', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('bad token'));
    await request(app).post('/api/v1/auth/google').send({ idToken: 'bad' });
    expect(await events()).toHaveLength(0);
  });

  it('POST /auth/logout records LOGOUT for the signed-in person (any role) and nothing else', async () => {
    const user = await makeUser();
    const res = await request(app).post('/api/v1/auth/logout').set(as(user));
    expect(res.status).toBe(200);
    const [logout] = await events('LOGOUT');
    expect(String(logout.user)).toBe(user.id);
    expect((await request(app).post('/api/v1/auth/logout')).status).toBe(401);
  });

  it('GET /auth/me (opening the app) moves last active', async () => {
    const user = await makeUser();
    await request(app).get('/api/v1/auth/me').set(as(user)).expect(200);
    await activityService.flushForTests();
    expect((await rawUser(user)).lastActiveAt).toBeInstanceOf(Date);
  });

  it('the bell\'s unread-count poll does NOT move last active', async () => {
    const user = await makeUser();
    await request(app).get('/api/v1/notifications/unread-count').set(as(user)).expect(200);
    await request(app).get('/api/v1/notifications/unread-count?x=1').set(as(user));
    await activityService.flushForTests();
    expect((await rawUser(user)).lastActiveAt).toBeUndefined();
    await request(app).get('/api/v1/notifications').set(as(user)).expect(200);
    await activityService.flushForTests();
    expect((await rawUser(user)).lastActiveAt).toBeInstanceOf(Date);
  });

  it('the cron endpoints create no events and move nobody\'s last active', async () => {
    const admin = await makeAdmin();
    await request(app).post('/api/v1/admin/trigger-reminders').set('X-Cron-Secret', env.CRON_SECRET).expect(200);
    await request(app).post('/api/v1/admin/trigger-receipt-reminders').set('X-Cron-Secret', env.CRON_SECRET).expect(200);
    expect(await events()).toHaveLength(0);
    expect((await rawUser(admin)).lastActiveAt).toBeUndefined();
  });

  it('the same reminders button pressed by an Admin IS logged', async () => {
    const admin = await makeAdmin();
    await request(app).post('/api/v1/admin/trigger-reminders').set(as(admin)).expect(200);
    const [event] = await events('REMINDERS_TRIGGERED');
    expect(String(event.user)).toBe(admin.id);
  });
});

describe('action hooks — the right type, small safe metadata', () => {
  it('task created / edited / reassigned / closed', async () => {
    const admin = await makeAdmin();
    const [a, b] = [await makeUser(), await makeUser()];
    const created = await request(app).post('/api/v1/tasks').set(as(admin)).send({ title: 'New', assignees: [a.id], responsibility: 'R', deadline: '2026-12-01' });
    const id = created.body.data.id;
    const code = created.body.data.codeNumber;

    // The edit form sends the same assignees again: only the title counts as changed.
    await request(app).patch(`/api/v1/tasks/${id}`).set(as(admin)).send({ title: 'Renamed', assignees: [a.id] }).expect(200);
    await request(app).patch(`/api/v1/tasks/${id}`).set(as(admin)).send({ assignees: [b.id] }).expect(200);
    await request(app).patch(`/api/v1/tasks/${id}`).set(as(admin)).send({ title: 'Renamed' }).expect(200); // no change: no event
    await request(app).patch(`/api/v1/tasks/${id}/close`).set(as(admin)).expect(200);

    const all = await events();
    expect(all.map((e) => e.type)).toEqual(['TASK_CREATED', 'TASK_EDITED', 'TASK_REASSIGNED', 'TASK_CLOSED']);
    expect(all[0].metadata).toEqual({ taskCode: code, assignees: 1 });
    expect(all[1].metadata).toEqual({ taskCode: code, fields: ['title'] });
    expect(all[2].metadata).toEqual({ taskCode: code, addedUserIds: [b.id], removedUserIds: [a.id] });
    expect(String(all[3].taskId)).toBe(id);
    expect(JSON.stringify(all)).not.toContain('Renamed');
  });

  it('a progress update: the percent and whether a file came — never the description', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user]);
    await request(app).post(`/api/v1/tasks/${task.id}/updates`).set(as(user)).send({ description: 'very private words', completionPercent: 40 }).expect(201);

    const [event] = await events('TASK_UPDATE_CREATED');
    expect(event.metadata).toEqual({ taskCode: task.codeNumber, completionPercent: 40, hasAttachment: false });
    expect(JSON.stringify(event)).not.toContain('private');
  });

  it('a receipt confirmed is logged once, not on the idempotent repeat', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user]);
    await request(app).post(`/api/v1/tasks/${task.id}/acknowledge`).set(as(user)).expect(200);
    await request(app).post(`/api/v1/tasks/${task.id}/acknowledge`).set(as(user)).expect(200);
    expect(await events('TASK_RECEIPT_CONFIRMED')).toHaveLength(1);
  });

  it('estimate edited / removed: the percentages only', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    // Two estimates: an edit makes a rating final (it can no longer be removed), so the removal is
    // made on the other one.
    const edited1 = await makeTask(admin, [user]);
    const removed1 = await makeTask(admin, [user]);
    const estimate = (assumedPercent) => ({ status: 'closed', performanceRating: 'good', syntheticRating: { isSynthetic: true, assumedPercent, assignedAt: new Date(), assignedBy: 'system:script', history: [] } });
    await Task.updateOne({ _id: edited1.id }, { $set: estimate(80) });
    await Task.updateOne({ _id: removed1.id }, { $set: estimate(85) });

    await request(app).patch(`/api/v1/tasks/${edited1.id}/synthetic-rating`).set(as(admin)).send({ assumedPercent: 92 }).expect(200);
    await request(app).delete(`/api/v1/tasks/${removed1.id}/synthetic-rating`).set(as(admin)).expect(200);

    const [edited] = await events('SYNTHETIC_RATING_EDITED');
    const [removed] = await events('SYNTHETIC_RATING_REMOVED');
    expect(edited.metadata).toEqual({ taskCode: edited1.codeNumber, fromPercent: 80, toPercent: 92 });
    expect(removed.metadata).toEqual({ taskCode: removed1.codeNumber, fromPercent: 85 });
  });

  it('a manual notification: mode, count and template — never the message', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const task = await makeTask(admin, [user]);
    await request(app).post('/api/v1/admin/notifications').set(as(admin)).send({ recipientType: 'all', message: 'secret broadcast text' }).expect(201);
    await request(app).post('/api/v1/admin/notifications').set(as(admin)).send({ recipientType: 'user', userId: user.id, templateKey: 'GENERAL_REMINDER' }).expect(201);
    await request(app).post(`/api/v1/admin/tasks/${task.id}/reminder`).set(as(admin)).send({ message: 'secret task text' }).expect(201);

    const sent = await events('NOTIFICATION_SENT');
    expect(sent.map((e) => e.metadata)).toEqual([
      { recipientMode: 'all', recipients: 1, templateKey: null },
      { recipientMode: 'user', recipients: 1, templateKey: 'GENERAL_REMINDER', targetUserId: user.id },
      { recipientMode: 'task', recipients: 1, templateKey: null },
    ]);
    expect(String(sent[2].taskId)).toBe(task.id);
    expect(JSON.stringify(sent)).not.toContain('secret');
  });

  it('user created / edited / deactivated / reactivated', async () => {
    const admin = await makeAdmin();
    const created = await request(app).post('/api/v1/users').set(as(admin)).send({ name: 'Newcomer', email: 'new@x.com', responsibility: 'R', role: 'user' }).expect(201);
    const id = created.body.data.id;
    await request(app).patch(`/api/v1/users/${id}`).set(as(admin)).send({ name: 'Renamed', isActive: false }).expect(200);
    await request(app).patch(`/api/v1/users/${id}`).set(as(admin)).send({ isActive: true }).expect(200);

    const all = await events();
    expect(all.map((e) => e.type)).toEqual(['USER_CREATED', 'USER_DEACTIVATED', 'USER_UPDATED', 'USER_REACTIVATED']);
    expect(all[2].metadata).toEqual({ targetUserId: id, fields: ['name'] });
    expect(JSON.stringify(all)).not.toContain('Renamed');
  });

  it('a task export: the format and filter KEYS — never the search text', async () => {
    const admin = await makeAdmin();
    await request(app).get('/api/v1/reports/export?format=excel&search=secretsearch&status=ongoing').set(as(admin)).expect(200);
    const [event] = await events('REPORT_EXPORTED');
    expect(event.metadata).toEqual({ format: 'excel', filters: ['status', 'search'], lastUpdateOnly: false });
    expect(JSON.stringify(event)).not.toContain('secretsearch');
  });

  it('a user-summary export', async () => {
    const admin = await makeAdmin();
    await request(app).get('/api/v1/reports/user-summary?format=excel').set(as(admin)).expect(200);
    const [event] = await events('USER_SUMMARY_EXPORTED');
    expect(event.metadata).toEqual({ format: 'excel' });
  });

  it('the responsibility list changed', async () => {
    const admin = await makeAdmin();
    const created = await request(app).post('/api/v1/lookup-lists').set(as(admin)).send({ listType: 'responsibility', value: 'Some role' }).expect(201);
    await request(app).patch(`/api/v1/lookup-lists/${created.body.data.id}`).set(as(admin)).send({ sortOrder: 3 }).expect(200);
    const all = await events('LOOKUP_LIST_CHANGED');
    expect(all.map((e) => e.metadata)).toEqual([
      { listType: 'responsibility', action: 'created' },
      { listType: 'responsibility', action: 'updated', fields: ['sortOrder'] },
    ]);
    expect(await LookupList.countDocuments()).toBe(1);
  });

  it('a failing event write never fails the action', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    jest.spyOn(ActivityEvent, 'create').mockRejectedValue(new Error('database down'));
    const res = await request(app).post('/api/v1/tasks').set(as(admin)).send({ title: 'Still works', assignees: [user.id], responsibility: 'R', deadline: '2026-12-01' });
    expect(res.status).toBe(201);
    await activityService.flushForTests();
  });
});
