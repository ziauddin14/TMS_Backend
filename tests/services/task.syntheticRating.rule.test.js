const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const TaskUpdate = require('../../src/models/TaskUpdate');
const taskService = require('../../src/services/task.service');
const taskUpdateService = require('../../src/services/taskUpdate.service');

// The rule for a task that carries a developer-assigned (synthetic) rating — task.service.js's
// applyComputedRating: the synthetic rating stays in force until the task earns a REAL rating
// (it is closed, or an update takes it to complete); only then is it replaced, the marker switched
// off, and the replacement recorded in the history. Exercised through the real entry points
// (taskUpdate.service.createUpdate and task.service.closeTask), not the helper in isolation.
beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

const ASSIGNED_AT = new Date('2026-10-05T06:00:00.000Z');
const FAR_FUTURE = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
const LONG_PAST = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);

async function makeUsers() {
  const assignee = await User.create({ name: 'Z', email: `z${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'user' });
  const admin = await User.create({ name: 'A', email: `a${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'رکن شوری', role: 'admin' });
  return { assignee, admin };
}

function syntheticRating(assumedPercent, rating) {
  return {
    isSynthetic: true,
    assumedPercent,
    assignedAt: ASSIGNED_AT,
    assignedBy: 'system:script',
    reason: 'test',
    history: [{ at: ASSIGNED_AT, by: 'system:script', fromPercent: null, toPercent: assumedPercent, fromRating: '-', toRating: rating, note: 'initial synthetic rating' }],
  };
}

let codeCounter = 0;
async function makeTask({ assignee, admin }, overrides = {}) {
  codeCounter += 1;
  return Task.create({
    codeNumber: `2610${String(codeCounter).padStart(2, '0')}`,
    title: 'کام',
    assignees: [assignee._id],
    responsibility: 'R',
    deadline: FAR_FUTURE,
    createdBy: admin._id,
    ...overrides,
  });
}
// A pending (overdue) task rated "weak" from an assumed 40%, and an ongoing one rated "fair" from 70%.
const pendingSynthetic = (users, extra = {}) =>
  makeTask(users, { status: 'pending', deadline: LONG_PAST, timeStatus: { type: 'overdue', days: 400 }, performanceRating: 'weak', syntheticRating: syntheticRating(40, 'weak'), ...extra });
const ongoingSynthetic = (users, extra = {}) =>
  makeTask(users, { status: 'ongoing', timeStatus: { type: 'remaining', days: 90 }, performanceRating: 'fair', syntheticRating: syntheticRating(70, 'fair'), ...extra });
const reload = (task) => Task.findById(task._id).lean();

describe('an update on an OPEN synthetic task keeps the synthetic rating', () => {
  it('pending task: the rating is not reset to "-", the marker and history are untouched — while the real fields update normally', async () => {
    const users = await makeUsers();
    const task = await pendingSynthetic(users);

    const { task: returned } = await taskUpdateService.createUpdate(
      { id: users.assignee.id, role: 'user' },
      task.id,
      { description: 'کام جاری ہے', completionPercent: 60 }
    );

    const after = await reload(task);
    expect(after.performanceRating).toBe('weak'); // without the rule this would have become '-'
    expect(after.syntheticRating.isSynthetic).toBe(true);
    expect(after.syntheticRating.assumedPercent).toBe(40);
    expect(after.syntheticRating.history).toHaveLength(1);
    // Real fields moved exactly as for any task.
    expect(after.status).toBe('pending');
    expect(after.completionPercent).toBe(60);
    expect(after.lastUpdateAt).toBeInstanceOf(Date);
    expect(await TaskUpdate.countDocuments({ taskId: task._id })).toBe(1);
    expect(returned.performanceRating).toBe('weak');
    // The KPI source still reads the assumed percent while the synthetic rating is in force.
    expect(Task.getEffectivePercent(after)).toBe(40);
  });

  it('ongoing task: the rating stays "fair" through several updates', async () => {
    const users = await makeUsers();
    const task = await ongoingSynthetic(users);
    const actor = { id: users.assignee.id, role: 'user' };

    await taskUpdateService.createUpdate(actor, task.id, { description: 'پہلی اپڈیٹ', completionPercent: 10 });
    await taskUpdateService.createUpdate(actor, task.id, { description: 'دوسری اپڈیٹ', completionPercent: 95 });

    const after = await reload(task);
    expect(after.performanceRating).toBe('fair');
    expect(after.syntheticRating).toMatchObject({ isSynthetic: true, assumedPercent: 70 });
    expect(after.syntheticRating.history).toHaveLength(1);
    expect(after.status).toBe('ongoing');
    expect(after.completionPercent).toBe(95);
  });
});

describe('a REAL rating replaces the synthetic one', () => {
  it('closing the task replaces performanceRating with the real rating and switches the marker off', async () => {
    const users = await makeUsers();
    // Really 95% done and not yet due: closing it now earns a real "excellent".
    const task = await ongoingSynthetic(users, { completionPercent: 95, lastUpdateAt: new Date() });

    const closed = await taskService.closeTask({ id: users.admin.id, role: 'admin' }, task.id);

    const after = await reload(task);
    expect(after.status).toBe('closed');
    expect(after.performanceRating).toBe('excellent'); // real — no longer the synthetic "fair"
    expect(after.syntheticRating.isSynthetic).toBe(false);
    expect(closed.performanceRating).toBe('excellent');
    // From here on the real percent is the effective one.
    expect(Task.getEffectivePercent(after)).toBe(95);
  });

  it('the real rule applies in full on close — including the late downgrade the synthetic rating never had', async () => {
    const users = await makeUsers();
    // Really 85% ("good"), but long overdue: the real rating is downgraded to "fair".
    const task = await pendingSynthetic(users, { completionPercent: 85 });

    await taskService.closeTask({ id: users.admin.id, role: 'admin' }, task.id);

    const after = await reload(task);
    expect(after.timeStatus.type).toBe('late');
    expect(after.performanceRating).toBe('fair');
    expect(after.syntheticRating.isSynthetic).toBe(false);
  });

  it('writes a history entry recording who replaced it, and from what to what', async () => {
    const users = await makeUsers();
    const task = await ongoingSynthetic(users, { completionPercent: 95, lastUpdateAt: new Date() });
    const startedAt = Date.now();

    await taskService.closeTask({ id: users.admin.id, role: 'admin' }, task.id);

    const { syntheticRating: after } = await reload(task);
    expect(after.history).toHaveLength(2);
    expect(after.history[0]).toMatchObject({ toPercent: 70, toRating: 'fair', note: 'initial synthetic rating' }); // the original entry is kept
    const entry = after.history[1];
    expect(entry).toMatchObject({
      fromPercent: 70, // what had been assumed
      toPercent: 95, // the real completion percent
      fromRating: 'fair',
      toRating: 'excellent',
      note: 'synthetic rating replaced by the real rating — task closed',
    });
    expect(String(entry.by)).toBe(users.admin.id);
    expect(entry.at.getTime()).toBeGreaterThanOrEqual(startedAt);
    // What was once assumed stays on record.
    expect(after).toMatchObject({ isSynthetic: false, assumedPercent: 70, assignedBy: 'system:script', reason: 'test' });
    expect(after.assignedAt.toISOString()).toBe(ASSIGNED_AT.toISOString());
  });

  it('an update that takes the task to 100% (status "complete") also yields a real rating, and records the person who posted it', async () => {
    const users = await makeUsers();
    const task = await ongoingSynthetic(users);

    await taskUpdateService.createUpdate({ id: users.assignee.id, role: 'user' }, task.id, { description: 'مکمل ہو گیا', completionPercent: 100 });

    const after = await reload(task);
    expect(after.status).toBe('complete');
    expect(after.performanceRating).toBe('excellent');
    expect(after.syntheticRating.isSynthetic).toBe(false);
    expect(after.syntheticRating.history[1]).toMatchObject({
      fromPercent: 70,
      toPercent: 100,
      fromRating: 'fair',
      toRating: 'excellent',
      note: 'synthetic rating replaced by the real rating — task completed',
    });
    expect(String(after.syntheticRating.history[1].by)).toBe(users.assignee.id);
  });

  it('once replaced, the task behaves like any other: later changes add no more history', async () => {
    const users = await makeUsers();
    const task = await ongoingSynthetic(users);
    const actor = { id: users.assignee.id, role: 'user' };
    await taskUpdateService.createUpdate(actor, task.id, { description: 'مکمل', completionPercent: 100 });

    await taskUpdateService.createUpdate(actor, task.id, { description: 'تصحیح', completionPercent: 75 });

    const after = await reload(task);
    expect(after.performanceRating).toBe('fair'); // real formula on the real 75%
    expect(after.syntheticRating.isSynthetic).toBe(false);
    expect(after.syntheticRating.history).toHaveLength(2);
  });
});

describe('tasks without a synthetic rating are unaffected by the rule', () => {
  it('an update on an ordinary open task still leaves the rating at "-", and creates no synthetic subdocument', async () => {
    const users = await makeUsers();
    const task = await makeTask(users, { status: 'ongoing' });

    await taskUpdateService.createUpdate({ id: users.assignee.id, role: 'user' }, task.id, { description: 'کام جاری ہے', completionPercent: 50 });

    const after = await reload(task);
    expect(after.performanceRating).toBe('-');
    expect(after.syntheticRating).toBeUndefined();
  });

  it('closing an ordinary task still computes its real rating, with no synthetic subdocument', async () => {
    const users = await makeUsers();
    const task = await makeTask(users, { status: 'ongoing', completionPercent: 85, lastUpdateAt: new Date() });

    await taskService.closeTask({ id: users.admin.id, role: 'admin' }, task.id);

    const after = await reload(task);
    expect(after.performanceRating).toBe('good');
    expect(after.syntheticRating).toBeUndefined();
  });
});
