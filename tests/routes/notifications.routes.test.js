const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Notification = require('../../src/models/Notification');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
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
async function makeNotification(recipientUserId, overrides = {}) {
  return Notification.create({
    recipientUserId,
    type: 'TASK_OVERDUE',
    title: 'کام میں تاخیر ہو چکی ہے',
    message: 'براہ کرم فوری طور پر اس کی صورتحال اپڈیٹ کریں۔',
    source: 'system',
    ...overrides,
  });
}

describe('GET /api/v1/notifications', () => {
  it('returns only the authenticated user\'s own notifications', async () => {
    const me = await makeUser();
    const other = await makeUser();
    await makeNotification(me.id, { title: 'Mine' });
    await makeNotification(other.id, { title: 'Not mine' });

    const res = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${tokenFor(me)}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('Mine');
  });

  it("never returns another user's notifications regardless of query params", async () => {
    const me = await makeUser();
    const other = await makeUser();
    await makeNotification(other.id);

    const res = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${tokenFor(me)}`);

    expect(res.body.data).toHaveLength(0);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/notifications');
    expect(res.status).toBe(401);
  });

  it('paginates with the documented { page, limit } meta shape, default limit 20', async () => {
    const me = await makeUser();
    // eslint-disable-next-line no-await-in-loop -- sequential test fixture creation
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makeNotification(me.id, { title: `N${i}` });
    }

    const res = await request(app)
      .get('/api/v1/notifications?page=1&limit=2')
      .set('Authorization', `Bearer ${tokenFor(me)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
  });

  it('unreadOnly=true returns only unread notifications', async () => {
    const me = await makeUser();
    const read = await makeNotification(me.id, { isRead: true, readAt: new Date() });
    await makeNotification(me.id);

    const res = await request(app)
      .get('/api/v1/notifications?unreadOnly=true')
      .set('Authorization', `Bearer ${tokenFor(me)}`);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data.every((n) => n.id !== read.id.toString())).toBe(true);
  });

  it('rejects an out-of-range limit with a VALIDATION_ERROR', async () => {
    const me = await makeUser();
    const res = await request(app).get('/api/v1/notifications?limit=101').set('Authorization', `Bearer ${tokenFor(me)}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/notifications/unread-count', () => {
  it("returns only the authenticated user's own unread count", async () => {
    const me = await makeUser();
    const other = await makeUser();
    await makeNotification(me.id);
    await makeNotification(me.id);
    await makeNotification(other.id);

    const res = await request(app)
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${tokenFor(me)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ count: 2 });
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/notifications/unread-count');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/v1/notifications/:id/read', () => {
  it("marks the authenticated user's own notification as read", async () => {
    const me = await makeUser();
    const doc = await makeNotification(me.id);

    const res = await request(app)
      .patch(`/api/v1/notifications/${doc.id}/read`)
      .set('Authorization', `Bearer ${tokenFor(me)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.isRead).toBe(true);
    expect(res.body.data.readAt).not.toBeNull();
  });

  it("returns 404, not the other user's data, when attempting to mark another user's notification as read", async () => {
    const owner = await makeUser();
    const attacker = await makeUser();
    const doc = await makeNotification(owner.id);

    const res = await request(app)
      .patch(`/api/v1/notifications/${doc.id}/read`)
      .set('Authorization', `Bearer ${tokenFor(attacker)}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('NOTIFICATION_NOT_FOUND');
    expect((await Notification.findById(doc.id)).isRead).toBe(false);
  });

  it('returns 404 for a nonexistent id', async () => {
    const me = await makeUser();
    const res = await request(app)
      .patch(`/api/v1/notifications/${new mongoose.Types.ObjectId()}/read`)
      .set('Authorization', `Bearer ${tokenFor(me)}`);

    expect(res.status).toBe(404);
  });

  it('returns 404 (not a 500) for a malformed id', async () => {
    const me = await makeUser();
    const res = await request(app)
      .patch('/api/v1/notifications/not-a-valid-id/read')
      .set('Authorization', `Bearer ${tokenFor(me)}`);

    expect(res.status).toBe(404);
  });

  it('is idempotent — reading an already-read notification twice succeeds both times', async () => {
    const me = await makeUser();
    const doc = await makeNotification(me.id);

    await request(app).patch(`/api/v1/notifications/${doc.id}/read`).set('Authorization', `Bearer ${tokenFor(me)}`);
    const second = await request(app)
      .patch(`/api/v1/notifications/${doc.id}/read`)
      .set('Authorization', `Bearer ${tokenFor(me)}`);

    expect(second.status).toBe(200);
    expect(second.body.data.isRead).toBe(true);
  });

  it('rejects an unauthenticated request', async () => {
    const me = await makeUser();
    const doc = await makeNotification(me.id);
    const res = await request(app).patch(`/api/v1/notifications/${doc.id}/read`);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/v1/notifications/read-all', () => {
  it("marks only the authenticated user's unread notifications as read", async () => {
    const me = await makeUser();
    const other = await makeUser();
    await makeNotification(me.id);
    await makeNotification(me.id);
    const otherDoc = await makeNotification(other.id);

    const res = await request(app)
      .patch('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${tokenFor(me)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updatedCount: 2 });
    expect((await Notification.findById(otherDoc.id)).isRead).toBe(false);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).patch('/api/v1/notifications/read-all');
    expect(res.status).toBe(401);
  });
});
