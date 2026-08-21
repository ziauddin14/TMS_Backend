const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const Task = require('../../src/models/Task');
const User = require('../../src/models/User');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

async function makeUser(overrides = {}) {
  return User.create({
    name: 'Assignee',
    email: `${new mongoose.Types.ObjectId()}@example.com`,
    responsibility: 'Donation Box Incharge',
    ...overrides,
  });
}

describe('Task model', () => {
  it('creates a valid task with documented defaults', async () => {
    const admin = await makeUser({ role: 'admin' });
    const assignee = await makeUser();

    const task = await Task.create({
      codeNumber: '260801',
      title: 'Monthly donation box collection report',
      assignees: [assignee._id],
      responsibility: 'Donation Box Incharge',
      deadline: new Date('2026-08-31'),
      createdBy: admin._id,
    });

    expect(task.status).toBe('ongoing'); // default
    expect(task.completionPercent).toBe(0); // default
    expect(task.performanceRating).toBe('-'); // default
    expect(task.timeStatus.type).toBe('remaining'); // sub-schema default
    expect(task.timeStatus.days).toBe(0);
    expect(task.lastUpdateAt).toBeNull();
    expect(task.closedBy).toBeNull();
    expect(task.closedAt).toBeNull();
  });

  it('supports multiple assignees (many-to-many, per confirmed decision)', async () => {
    const admin = await makeUser({ role: 'admin' });
    const a1 = await makeUser();
    const a2 = await makeUser();

    const task = await Task.create({
      codeNumber: '260802',
      title: 'Multi-assignee task',
      assignees: [a1._id, a2._id],
      responsibility: 'Donation Box Incharge',
      deadline: new Date('2026-08-31'),
      createdBy: admin._id,
    });

    expect(task.assignees).toHaveLength(2);
  });

  it('rejects a task with an empty assignees array', async () => {
    const admin = await makeUser({ role: 'admin' });

    await expect(
      Task.create({
        codeNumber: '260803',
        title: 'No assignees',
        assignees: [],
        responsibility: 'X',
        deadline: new Date('2026-08-31'),
        createdBy: admin._id,
      })
    ).rejects.toThrow(/A task needs at least one assignee/);
  });

  it('rejects a task missing assignees entirely', async () => {
    const admin = await makeUser({ role: 'admin' });

    await expect(
      Task.create({
        codeNumber: '260804',
        title: 'No assignees field',
        responsibility: 'X',
        deadline: new Date('2026-08-31'),
        createdBy: admin._id,
      })
    ).rejects.toThrow(/A task needs at least one assignee/);
  });

  it('requires title, responsibility, deadline, and createdBy', async () => {
    const assignee = await makeUser();
    await expect(
      Task.create({ codeNumber: '260805', assignees: [assignee._id] })
    ).rejects.toThrow();
  });

  it('enforces codeNumber uniqueness', async () => {
    const admin = await makeUser({ role: 'admin' });
    const assignee = await makeUser();
    const base = {
      title: 'Task',
      assignees: [assignee._id],
      responsibility: 'X',
      deadline: new Date('2026-08-31'),
      createdBy: admin._id,
    };

    await Task.create({ ...base, codeNumber: '260806' });

    await expect(Task.create({ ...base, codeNumber: '260806' })).rejects.toThrow(/E11000/);
  });

  it('rejects a status outside the documented lifecycle enum', async () => {
    const admin = await makeUser({ role: 'admin' });
    const assignee = await makeUser();

    await expect(
      Task.create({
        codeNumber: '260807',
        title: 'Bad status',
        assignees: [assignee._id],
        responsibility: 'X',
        deadline: new Date('2026-08-31'),
        createdBy: admin._id,
        status: 'archived',
      })
    ).rejects.toThrow();
  });

  it('bounds completionPercent to 0-100', async () => {
    const admin = await makeUser({ role: 'admin' });
    const assignee = await makeUser();

    await expect(
      Task.create({
        codeNumber: '260808',
        title: 'Over 100',
        assignees: [assignee._id],
        responsibility: 'X',
        deadline: new Date('2026-08-31'),
        createdBy: admin._id,
        completionPercent: 150,
      })
    ).rejects.toThrow();
  });

  it('rejects a performanceRating outside the documented enum', async () => {
    const admin = await makeUser({ role: 'admin' });
    const assignee = await makeUser();

    await expect(
      Task.create({
        codeNumber: '260809',
        title: 'Bad rating',
        assignees: [assignee._id],
        responsibility: 'X',
        deadline: new Date('2026-08-31'),
        createdBy: admin._id,
        performanceRating: 'outstanding',
      })
    ).rejects.toThrow();
  });

  it('has no schema-level delete restriction (deletion is prevented structurally by never having a DELETE route, a later routing-layer concern)', async () => {
    const admin = await makeUser({ role: 'admin' });
    const assignee = await makeUser();
    const task = await Task.create({
      codeNumber: '260810',
      title: 'Closeable',
      assignees: [assignee._id],
      responsibility: 'X',
      deadline: new Date('2026-08-31'),
      createdBy: admin._id,
    });

    task.status = 'closed';
    task.closedBy = admin._id;
    task.closedAt = new Date();
    await task.save();

    const found = await Task.findById(task._id);
    expect(found.status).toBe('closed');
    expect(found.closedBy.toString()).toBe(admin._id.toString());
  });
});
