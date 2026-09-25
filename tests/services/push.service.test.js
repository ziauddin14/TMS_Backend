const mockSendNotification = jest.fn();
const mockSetVapidDetails = jest.fn();

jest.mock('web-push', () => ({
  setVapidDetails: (...args) => mockSetVapidDetails(...args),
  sendNotification: (...args) => mockSendNotification(...args),
}));

const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const PushSubscription = require('../../src/models/PushSubscription');
const pushService = require('../../src/services/push.service');

beforeAll(async () => connect());
afterEach(async () => {
  await clearDatabase();
  mockSendNotification.mockReset();
});
afterAll(async () => closeDatabase());

function fakeSubPayload(overrides = {}) {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${new mongoose.Types.ObjectId()}`,
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    ...overrides,
  };
}

describe('push.service — saveSubscription', () => {
  it('creates a new subscription for a user', async () => {
    const userId = new mongoose.Types.ObjectId();
    const sub = await pushService.saveSubscription(userId, fakeSubPayload());

    expect(sub.userId.toString()).toBe(userId.toString());
    expect(await PushSubscription.countDocuments({ userId })).toBe(1);
  });

  it('re-subscribing the same endpoint updates (upserts) rather than creating a duplicate row', async () => {
    const userId = new mongoose.Types.ObjectId();
    const payload = fakeSubPayload();
    await pushService.saveSubscription(userId, payload);

    await pushService.saveSubscription(userId, { ...payload, keys: { p256dh: 'new-p256dh', auth: 'new-auth' } });

    expect(await PushSubscription.countDocuments({ endpoint: payload.endpoint })).toBe(1);
    const stored = await PushSubscription.findOne({ endpoint: payload.endpoint });
    expect(stored.keys.p256dh).toBe('new-p256dh');
  });

  it('one user can have multiple subscriptions (phone + laptop) with different endpoints', async () => {
    const userId = new mongoose.Types.ObjectId();
    await pushService.saveSubscription(userId, fakeSubPayload());
    await pushService.saveSubscription(userId, fakeSubPayload());

    expect(await PushSubscription.countDocuments({ userId })).toBe(2);
  });
});

describe('push.service — removeSubscription', () => {
  it('removes a subscription owned by the given user', async () => {
    const userId = new mongoose.Types.ObjectId();
    const payload = fakeSubPayload();
    await pushService.saveSubscription(userId, payload);

    const result = await pushService.removeSubscription(userId, payload.endpoint);

    expect(result.deletedCount).toBe(1);
    expect(await PushSubscription.countDocuments({ endpoint: payload.endpoint })).toBe(0);
  });

  it("does NOT remove another user's subscription, even given the exact right endpoint", async () => {
    const owner = new mongoose.Types.ObjectId();
    const attacker = new mongoose.Types.ObjectId();
    const payload = fakeSubPayload();
    await pushService.saveSubscription(owner, payload);

    const result = await pushService.removeSubscription(attacker, payload.endpoint);

    expect(result.deletedCount).toBe(0);
    expect(await PushSubscription.countDocuments({ endpoint: payload.endpoint })).toBe(1);
  });

  it('is idempotent — removing an already-gone subscription is a no-op, not an error', async () => {
    const userId = new mongoose.Types.ObjectId();
    await expect(
      pushService.removeSubscription(userId, 'https://fcm.googleapis.com/fcm/send/never-existed')
    ).resolves.toEqual({ deletedCount: 0 });
  });
});

describe('push.service — sendPushToUser', () => {
  it('sends to every subscription this user has, in parallel, with the exact payload as JSON', async () => {
    const userId = new mongoose.Types.ObjectId();
    await pushService.saveSubscription(userId, fakeSubPayload());
    await pushService.saveSubscription(userId, fakeSubPayload());
    mockSendNotification.mockResolvedValue({});

    await pushService.sendPushToUser(userId, { title: 'T', body: 'B' });

    expect(mockSendNotification).toHaveBeenCalledTimes(2);
    const [subscriptionArg, bodyArg] = mockSendNotification.mock.calls[0];
    expect(subscriptionArg).toHaveProperty('endpoint');
    expect(subscriptionArg.keys).toEqual({ p256dh: 'p256dh-key', auth: 'auth-key' });
    expect(JSON.parse(bodyArg)).toEqual({ title: 'T', body: 'B' });
  });

  it('does nothing (no error) when the user has no subscriptions', async () => {
    const userId = new mongoose.Types.ObjectId();

    await expect(pushService.sendPushToUser(userId, { title: 'T', body: 'B' })).resolves.toBeUndefined();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('one subscription failing does not stop the other on the same user from being sent to', async () => {
    const userId = new mongoose.Types.ObjectId();
    const failing = fakeSubPayload();
    const ok = fakeSubPayload();
    await pushService.saveSubscription(userId, failing);
    await pushService.saveSubscription(userId, ok);
    mockSendNotification.mockImplementation((sub) =>
      sub.endpoint === failing.endpoint ? Promise.reject(new Error('network error')) : Promise.resolve({})
    );

    await pushService.sendPushToUser(userId, { title: 'T', body: 'B' });

    expect(mockSendNotification).toHaveBeenCalledTimes(2);
  });

  it('a 410 Gone error deletes the dead subscription', async () => {
    const userId = new mongoose.Types.ObjectId();
    const payload = fakeSubPayload();
    await pushService.saveSubscription(userId, payload);
    const err = new Error('Gone');
    err.statusCode = 410;
    mockSendNotification.mockRejectedValue(err);

    await pushService.sendPushToUser(userId, { title: 'T', body: 'B' });

    expect(await PushSubscription.countDocuments({ endpoint: payload.endpoint })).toBe(0);
  });

  it('a 404 error on send also deletes the dead subscription (some push services use 404 for the same condition)', async () => {
    const userId = new mongoose.Types.ObjectId();
    const payload = fakeSubPayload();
    await pushService.saveSubscription(userId, payload);
    const err = new Error('Not Found');
    err.statusCode = 404;
    mockSendNotification.mockRejectedValue(err);

    await pushService.sendPushToUser(userId, { title: 'T', body: 'B' });

    expect(await PushSubscription.countDocuments({ endpoint: payload.endpoint })).toBe(0);
  });

  it('a transient error (e.g. 500) does NOT delete the subscription — only 410/404 do', async () => {
    const userId = new mongoose.Types.ObjectId();
    const payload = fakeSubPayload();
    await pushService.saveSubscription(userId, payload);
    const err = new Error('Service unavailable');
    err.statusCode = 500;
    mockSendNotification.mockRejectedValue(err);

    await pushService.sendPushToUser(userId, { title: 'T', body: 'B' });

    expect(await PushSubscription.countDocuments({ endpoint: payload.endpoint })).toBe(1);
  });
});

describe('push.service — listSubscriptionsForUser', () => {
  it("returns only the given user's subscriptions", async () => {
    const me = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    await pushService.saveSubscription(me, fakeSubPayload());
    await pushService.saveSubscription(other, fakeSubPayload());

    const mine = await pushService.listSubscriptionsForUser(me);

    expect(mine).toHaveLength(1);
    expect(mine[0].userId.toString()).toBe(me.toString());
  });
});
