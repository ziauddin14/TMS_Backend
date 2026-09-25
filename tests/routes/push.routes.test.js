const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const PushSubscription = require('../../src/models/PushSubscription');

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
function subscriptionBody(overrides = {}) {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${new mongoose.Types.ObjectId()}`,
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    ...overrides,
  };
}

describe('POST /api/v1/push/subscribe', () => {
  it('saves a new subscription for the authenticated user', async () => {
    const user = await makeUser();
    const body = subscriptionBody();

    const res = await request(app)
      .post('/api/v1/push/subscribe')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ subscribed: true });
    const stored = await PushSubscription.findOne({ endpoint: body.endpoint });
    expect(stored.userId.toString()).toBe(user.id);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/v1/push/subscribe').send(subscriptionBody());
    expect(res.status).toBe(401);
  });

  it('rejects a malformed body (missing keys) with VALIDATION_ERROR', async () => {
    const user = await makeUser();
    const res = await request(app)
      .post('/api/v1/push/subscribe')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/x' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('re-subscribing the same endpoint (different user) reassigns ownership rather than erroring', async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const body = subscriptionBody();
    await request(app).post('/api/v1/push/subscribe').set('Authorization', `Bearer ${tokenFor(userA)}`).send(body);

    const res = await request(app)
      .post('/api/v1/push/subscribe')
      .set('Authorization', `Bearer ${tokenFor(userB)}`)
      .send(body);

    expect(res.status).toBe(201);
    const stored = await PushSubscription.findOne({ endpoint: body.endpoint });
    expect(stored.userId.toString()).toBe(userB.id);
    expect(await PushSubscription.countDocuments({ endpoint: body.endpoint })).toBe(1);
  });
});

describe('POST /api/v1/push/unsubscribe', () => {
  it('removes the caller\'s own subscription', async () => {
    const user = await makeUser();
    const body = subscriptionBody();
    await request(app).post('/api/v1/push/subscribe').set('Authorization', `Bearer ${tokenFor(user)}`).send(body);

    const res = await request(app)
      .post('/api/v1/push/unsubscribe')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ endpoint: body.endpoint });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ subscribed: false });
    expect(await PushSubscription.countDocuments({ endpoint: body.endpoint })).toBe(0);
  });

  it("does not remove another user's subscription", async () => {
    const owner = await makeUser();
    const attacker = await makeUser();
    const body = subscriptionBody();
    await request(app).post('/api/v1/push/subscribe').set('Authorization', `Bearer ${tokenFor(owner)}`).send(body);

    const res = await request(app)
      .post('/api/v1/push/unsubscribe')
      .set('Authorization', `Bearer ${tokenFor(attacker)}`)
      .send({ endpoint: body.endpoint });

    expect(res.status).toBe(200); // idempotent-style response, no information leak either way
    expect(await PushSubscription.countDocuments({ endpoint: body.endpoint })).toBe(1);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/v1/push/unsubscribe').send({ endpoint: 'https://x.test/y' });
    expect(res.status).toBe(401);
  });
});
