const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const NotificationBatch = require('../../src/models/NotificationBatch');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

function baseDoc(overrides = {}) {
  return {
    createdBy: new mongoose.Types.ObjectId(),
    recipientMode: 'all',
    message: 'Test message',
    recipientsResolved: 3,
    createdCount: 3,
    ...overrides,
  };
}

describe('NotificationBatch model (locked blueprint §2 — audit summary, NOT a second notification store)', () => {
  it('creates a valid entry with documented defaults', async () => {
    const batch = await NotificationBatch.create(baseDoc());

    expect(batch.targetUserId).toBeNull();
    expect(batch.targetTaskId).toBeNull();
    expect(batch.templateKey).toBeNull();
    expect(batch.failures).toEqual([]);
    expect(batch.createdAt).toBeInstanceOf(Date); // timestamps: true
  });

  it('requires createdBy, recipientMode, message, recipientsResolved, createdCount', async () => {
    await expect(NotificationBatch.create({})).rejects.toThrow();
    await expect(NotificationBatch.create(baseDoc({ createdBy: undefined }))).rejects.toThrow();
    await expect(NotificationBatch.create(baseDoc({ recipientMode: undefined }))).rejects.toThrow();
    await expect(NotificationBatch.create(baseDoc({ message: undefined }))).rejects.toThrow();
    await expect(NotificationBatch.create(baseDoc({ recipientsResolved: undefined }))).rejects.toThrow();
    await expect(NotificationBatch.create(baseDoc({ createdCount: undefined }))).rejects.toThrow();
  });

  it('rejects a recipientMode outside the documented enum', async () => {
    await expect(NotificationBatch.create(baseDoc({ recipientMode: 'broadcast' }))).rejects.toThrow();
  });

  it('accepts recipientMode "user" and "task"', async () => {
    await expect(NotificationBatch.create(baseDoc({ recipientMode: 'user' }))).resolves.toBeDefined();
    await expect(NotificationBatch.create(baseDoc({ recipientMode: 'task' }))).resolves.toBeDefined();
  });

  it('stores a failures array with recipientUserId/name/reason', async () => {
    const recipientUserId = new mongoose.Types.ObjectId();
    const batch = await NotificationBatch.create(
      baseDoc({
        createdCount: 2,
        failures: [{ recipientUserId, name: 'Ali', reason: 'Some error' }],
      })
    );

    expect(batch.failures).toHaveLength(1);
    expect(batch.failures[0].recipientUserId.toString()).toBe(recipientUserId.toString());
    expect(batch.failures[0].name).toBe('Ali');
    expect(batch.failures[0].reason).toBe('Some error');
  });

  it('does NOT require uniqueness on anything — multiple batches from the same admin are all valid data', async () => {
    const createdBy = new mongoose.Types.ObjectId();
    await NotificationBatch.create(baseDoc({ createdBy }));
    await expect(NotificationBatch.create(baseDoc({ createdBy }))).resolves.toBeDefined();
  });

  it('exposes the documented { createdAt: -1 } and { createdBy: 1, createdAt: -1 } indexes', async () => {
    const indexes = await NotificationBatch.collection.getIndexes({ full: true });

    const byCreatedAt = indexes.find((idx) => Object.keys(idx.key).join(',') === 'createdAt');
    expect(byCreatedAt).toBeDefined();
    expect(byCreatedAt.key).toMatchObject({ createdAt: -1 });

    const byCreatedByAndCreatedAt = indexes.find((idx) => Object.keys(idx.key).join(',') === 'createdBy,createdAt');
    expect(byCreatedByAndCreatedAt).toBeDefined();
    expect(byCreatedByAndCreatedAt.key).toMatchObject({ createdBy: 1, createdAt: -1 });
  });

  it('serializes _id -> id via the shared applyToJSON plugin, matching every other model', async () => {
    const batch = await NotificationBatch.create(baseDoc());
    const json = batch.toJSON();

    expect(json.id).toBe(batch._id.toString());
    expect(json._id).toBeUndefined();
  });
});
