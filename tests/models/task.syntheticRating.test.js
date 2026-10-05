const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const Task = require('../../src/models/Task');
const { ratingForPercent, computePerformanceRating } = require('../../src/services/task.service');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

function baseTask(overrides = {}) {
  return {
    codeNumber: `26${Math.floor(Math.random() * 9000 + 1000)}`,
    title: 'Sample',
    assignees: [new mongoose.Types.ObjectId()],
    responsibility: 'R',
    deadline: new Date('2026-12-31T00:00:00.000Z'),
    createdBy: new mongoose.Types.ObjectId(),
    ...overrides,
  };
}
const synthetic = (overrides = {}) => ({
  isSynthetic: true,
  assumedPercent: 80,
  assignedAt: new Date('2026-10-05T00:00:00.000Z'),
  assignedBy: 'system:script',
  reason: 'test',
  ...overrides,
});

describe('Task.syntheticRating (additive, optional)', () => {
  it('is absent on a task that was never given one — existing documents are unaffected', async () => {
    const created = await Task.create(baseTask());

    const raw = await Task.collection.findOne({ _id: created._id });
    expect(Object.keys(raw)).not.toContain('syntheticRating');
    expect((await Task.findById(created._id)).syntheticRating).toBeUndefined();
    expect(created.toJSON()).not.toHaveProperty('syntheticRating');
  });

  it('a document written before the field existed still loads, saves and keeps working', async () => {
    const id = new mongoose.Types.ObjectId();
    await Task.collection.insertOne({ _id: id, ...baseTask(), status: 'closed', completionPercent: 56, performanceRating: 'weak', timeStatus: { type: 'late', days: 3 } });

    const task = await Task.findById(id);
    task.title = 'Edited';
    await task.save();

    const raw = await Task.collection.findOne({ _id: id });
    expect(raw.title).toBe('Edited');
    expect(raw.performanceRating).toBe('weak');
    expect(Object.keys(raw)).not.toContain('syntheticRating');
  });

  it('stores the subdocument with its history, accepting a user id or a marker string as the author', async () => {
    const adminId = new mongoose.Types.ObjectId();
    const created = await Task.create(
      baseTask({
        performanceRating: 'good',
        syntheticRating: synthetic({ history: [{ at: new Date('2026-10-05T00:00:00.000Z'), by: adminId, fromPercent: null, toPercent: 80, fromRating: '-', toRating: 'good', note: 'initial' }] }),
      })
    );

    const found = await Task.findById(created._id).lean();
    expect(found.syntheticRating).toMatchObject({ isSynthetic: true, assumedPercent: 80, assignedBy: 'system:script', reason: 'test' });
    expect(found.syntheticRating.history).toHaveLength(1);
    expect(String(found.syntheticRating.history[0].by)).toBe(String(adminId));
  });

  it('rejects an assumed percent outside 0–100', async () => {
    await expect(Task.create(baseTask({ syntheticRating: synthetic({ assumedPercent: 101 }) }))).rejects.toThrow(/assumedPercent/);
    await expect(Task.create(baseTask({ syntheticRating: synthetic({ assumedPercent: -1 }) }))).rejects.toThrow(/assumedPercent/);
  });

  it('survives an ordinary save of the task by the app (it is not dropped or reset)', async () => {
    const created = await Task.create(baseTask({ status: 'pending', performanceRating: 'weak', syntheticRating: synthetic({ assumedPercent: 40 }) }));

    const task = await Task.findById(created._id);
    task.timeStatus = { type: 'overdue', days: 9 }; // what the daily reminder engine does
    await task.save();

    expect((await Task.findById(created._id).lean()).syntheticRating).toMatchObject({ isSynthetic: true, assumedPercent: 40 });
  });
});

describe('Task.getEffectivePercent', () => {
  it('is the real completionPercent for a task with no synthetic rating', () => {
    expect(Task.getEffectivePercent({ completionPercent: 56 })).toBe(56);
    expect(Task.getEffectivePercent({ completionPercent: 0 })).toBe(0);
  });

  it('is the assumed percent while the task carries a synthetic rating', () => {
    expect(Task.getEffectivePercent({ completionPercent: 0, syntheticRating: { isSynthetic: true, assumedPercent: 80 } })).toBe(80);
  });

  it('falls back to the real percent once a synthetic rating is no longer in force', () => {
    expect(Task.getEffectivePercent({ completionPercent: 30, syntheticRating: { isSynthetic: false, assumedPercent: 80 } })).toBe(30);
  });

  it('works on a Mongoose document as well as a lean object', async () => {
    const doc = await Task.create(baseTask({ completionPercent: 10, syntheticRating: synthetic({ assumedPercent: 70 }) }));
    expect(Task.getEffectivePercent(doc)).toBe(70);
  });
});

describe('ratingForPercent — the one definition of the thresholds', () => {
  it.each([
    [100, 'excellent'],
    [90, 'excellent'],
    [89.9, 'good'],
    [80, 'good'],
    [79.9, 'fair'],
    [70, 'fair'],
    [69.9, 'weak'],
    [40, 'weak'],
    [0, 'weak'],
  ])('%s%% → %s', (percent, rating) => {
    expect(ratingForPercent(percent)).toBe(rating);
  });

  it('is exactly what a real, on-time rating uses — and has no late downgrade of its own', () => {
    [0, 40, 69.9, 70, 80, 90, 100].forEach((percent) => {
      expect(computePerformanceRating(percent, { type: 'early', days: 1 }, 'closed')).toBe(ratingForPercent(percent));
    });
    expect(computePerformanceRating(80, { type: 'late', days: 1 }, 'closed')).toBe('fair'); // the real rule still downgrades
    expect(ratingForPercent(80)).toBe('good');
  });
});
