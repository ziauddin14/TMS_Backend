const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const PushSubscription = require('../../src/models/PushSubscription');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

function baseDoc(overrides = {}) {
  return {
    userId: new mongoose.Types.ObjectId(),
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh: 'p256dh-key-value', auth: 'auth-key-value' },
    ...overrides,
  };
}

describe('PushSubscription model (Web Push addition)', () => {
  it('creates a valid entry with documented defaults', async () => {
    const entry = await PushSubscription.create(baseDoc());

    expect(entry.deviceInfo).toBeNull();
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it('requires userId, endpoint, keys.p256dh, and keys.auth', async () => {
    await expect(PushSubscription.create({})).rejects.toThrow();
    await expect(PushSubscription.create(baseDoc({ userId: undefined }))).rejects.toThrow();
    await expect(PushSubscription.create(baseDoc({ endpoint: undefined }))).rejects.toThrow();
    await expect(PushSubscription.create({ ...baseDoc(), keys: { auth: 'x' } })).rejects.toThrow();
    await expect(PushSubscription.create({ ...baseDoc(), keys: { p256dh: 'x' } })).rejects.toThrow();
  });

  it('enforces a UNIQUE index on endpoint — the same browser subscription can never be stored twice', async () => {
    await PushSubscription.create(baseDoc());
    await expect(PushSubscription.create(baseDoc())).rejects.toMatchObject({ code: 11000 });
  });

  it('allows the same user to have multiple subscriptions with different endpoints (phone + laptop)', async () => {
    const userId = new mongoose.Types.ObjectId();
    await PushSubscription.create(baseDoc({ userId, endpoint: 'https://fcm.googleapis.com/fcm/send/device-a' }));
    await PushSubscription.create(baseDoc({ userId, endpoint: 'https://fcm.googleapis.com/fcm/send/device-b' }));

    expect(await PushSubscription.countDocuments({ userId })).toBe(2);
  });

  it('exposes the userId index', async () => {
    const indexes = await PushSubscription.collection.getIndexes({ full: true });
    const byUserId = indexes.find((idx) => Object.keys(idx.key).join(',') === 'userId');
    expect(byUserId).toBeDefined();
  });

  it('serializes _id -> id via the shared applyToJSON plugin, matching every other model', async () => {
    const entry = await PushSubscription.create(baseDoc());
    const json = entry.toJSON();

    expect(json.id).toBe(entry._id.toString());
    expect(json._id).toBeUndefined();
  });
});
