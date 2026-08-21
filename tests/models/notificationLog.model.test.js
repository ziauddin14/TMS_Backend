const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const NotificationLog = require('../../src/models/NotificationLog');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

describe('NotificationLog model', () => {
  it('creates a valid entry with documented defaults', async () => {
    const taskId = new mongoose.Types.ObjectId();

    const entry = await NotificationLog.create({ taskId, type: 'deadline_soon' });

    expect(entry.channel).toBe('email'); // default
    expect(entry.sentAt).toBeInstanceOf(Date); // defaults to Date.now
  });

  it('requires taskId and type', async () => {
    await expect(NotificationLog.create({})).rejects.toThrow();
  });

  it('rejects a type outside the documented enum', async () => {
    const taskId = new mongoose.Types.ObjectId();
    await expect(
      NotificationLog.create({ taskId, type: 'reminder' })
    ).rejects.toThrow();
  });

  it('rejects a channel outside the documented enum', async () => {
    const taskId = new mongoose.Types.ObjectId();
    await expect(
      NotificationLog.create({ taskId, type: 'overdue', channel: 'sms' })
    ).rejects.toThrow();
  });

  it('exposes the documented { taskId, type, sentAt } compound index for the reminder job to query on', async () => {
    const indexes = await NotificationLog.collection.getIndexes({ full: true });
    const compound = indexes.find(
      (idx) =>
        Object.keys(idx.key).join(',') === 'taskId,type,sentAt' &&
        idx.key.taskId === 1 &&
        idx.key.type === 1 &&
        idx.key.sentAt === -1
    );
    expect(compound).toBeDefined();
  });

  it(
    'does NOT enforce uniqueness on (taskId, type) at the schema level — ' +
      'docs/04-db-models.md §7 defines only a query-support index here; the reminder job ' +
      '(a later phase) is responsible for checking before it inserts, so duplicate log rows ' +
      'are valid data at the model layer',
    async () => {
      const taskId = new mongoose.Types.ObjectId();

      await NotificationLog.create({ taskId, type: 'overdue' });
      await expect(NotificationLog.create({ taskId, type: 'overdue' })).resolves.toBeDefined();

      const count = await NotificationLog.countDocuments({ taskId, type: 'overdue' });
      expect(count).toBe(2);
    }
  );
});
