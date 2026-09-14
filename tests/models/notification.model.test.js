const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const Notification = require('../../src/models/Notification');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

function baseDoc(overrides = {}) {
  return {
    recipientUserId: new mongoose.Types.ObjectId(),
    type: 'TASK_OVERDUE',
    title: 'Title',
    message: 'Message',
    source: 'system',
    ...overrides,
  };
}

describe('Notification model (locked blueprint §2)', () => {
  it('creates a valid entry with documented defaults', async () => {
    const entry = await Notification.create(baseDoc());

    expect(entry.taskId).toBeNull();
    expect(entry.createdBy).toBeNull();
    expect(entry.isRead).toBe(false);
    expect(entry.readAt).toBeNull();
    // No schema default (deliberately, see the model's own comment) — genuinely absent, not null,
    // so the sparse unique index correctly excludes documents that never set it.
    expect(entry.dedupKey).toBeUndefined();
    expect(entry.metadata).toEqual({});
    expect(entry.createdAt).toBeInstanceOf(Date); // timestamps: true
  });

  it('requires recipientUserId, type, title, message, and source', async () => {
    await expect(Notification.create({})).rejects.toThrow();
    await expect(Notification.create(baseDoc({ type: undefined }))).rejects.toThrow();
    await expect(Notification.create(baseDoc({ title: undefined }))).rejects.toThrow();
    await expect(Notification.create(baseDoc({ message: undefined }))).rejects.toThrow();
    await expect(Notification.create(baseDoc({ source: undefined }))).rejects.toThrow();
  });

  it('accepts any string `type` — not a hard Mongoose enum (locked blueprint §3, extensibility)', async () => {
    const entry = await Notification.create(baseDoc({ type: 'SOME_FUTURE_TYPE_NOT_YET_REGISTERED' }));
    expect(entry.type).toBe('SOME_FUTURE_TYPE_NOT_YET_REGISTERED');
  });

  it('rejects a `source` outside the documented enum', async () => {
    await expect(Notification.create(baseDoc({ source: 'email' }))).rejects.toThrow();
  });

  it('exposes the three documented compound/simple query indexes', async () => {
    const indexes = await Notification.collection.getIndexes({ full: true });

    const byRecipientUnread = indexes.find(
      (idx) => Object.keys(idx.key).join(',') === 'recipientUserId,isRead,createdAt'
    );
    expect(byRecipientUnread).toBeDefined();
    expect(byRecipientUnread.key).toMatchObject({ recipientUserId: 1, isRead: 1, createdAt: -1 });

    const byRecipient = indexes.find((idx) => Object.keys(idx.key).join(',') === 'recipientUserId,createdAt');
    expect(byRecipient).toBeDefined();
    expect(byRecipient.key).toMatchObject({ recipientUserId: 1, createdAt: -1 });

    const byTaskId = indexes.find((idx) => Object.keys(idx.key).join(',') === 'taskId');
    expect(byTaskId).toBeDefined();
  });

  it('enforces a UNIQUE, SPARSE index on dedupKey', async () => {
    const indexes = await Notification.collection.getIndexes({ full: true });
    const dedupIndex = indexes.find((idx) => Object.keys(idx.key).join(',') === 'dedupKey');

    expect(dedupIndex).toBeDefined();
    expect(dedupIndex.unique).toBe(true);
    expect(dedupIndex.sparse).toBe(true);
  });

  it('rejects a second document with the same dedupKey', async () => {
    await Notification.create(baseDoc({ dedupKey: 'AUTO_REMINDER:task1:user1:2026-09-14' }));

    await expect(
      Notification.create(baseDoc({ dedupKey: 'AUTO_REMINDER:task1:user1:2026-09-14' }))
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('allows multiple documents with dedupKey left null (sparse index ignores missing values) — admin-sourced rows are never deduped', async () => {
    await Notification.create(baseDoc({ source: 'admin' }));
    await Notification.create(baseDoc({ source: 'admin' }));

    const count = await Notification.countDocuments({ dedupKey: null });
    expect(count).toBe(2);
  });

  it('serializes _id -> id via the shared applyToJSON plugin, matching every other model', async () => {
    const entry = await Notification.create(baseDoc());
    const json = entry.toJSON();

    expect(json.id).toBe(entry._id.toString());
    expect(json._id).toBeUndefined();
  });
});
