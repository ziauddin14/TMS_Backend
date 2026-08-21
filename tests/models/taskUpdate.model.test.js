const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const TaskUpdate = require('../../src/models/TaskUpdate');
const Task = require('../../src/models/Task');
const User = require('../../src/models/User');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

async function makeTaskAndUser() {
  const admin = await User.create({
    name: 'Admin',
    email: 'admin@example.com',
    responsibility: 'Admin',
    role: 'admin',
  });
  const assignee = await User.create({
    name: 'Assignee',
    email: 'assignee@example.com',
    responsibility: 'X',
  });
  const task = await Task.create({
    codeNumber: '260901',
    title: 'Task',
    assignees: [assignee._id],
    responsibility: 'X',
    deadline: new Date('2026-09-30'),
    createdBy: admin._id,
  });
  return { admin, assignee, task };
}

describe('TaskUpdate model', () => {
  it('creates a valid update with required fields', async () => {
    const { assignee, task } = await makeTaskAndUser();

    const update = await TaskUpdate.create({
      taskId: task._id,
      updatedBy: assignee._id,
      description: '3 boxes collected so far, 2 remaining.',
      completionPercent: 40,
    });

    expect(update.completionPercent).toBe(40);
    expect(update.attachment).toBeNull();
    expect(update.createdAt).toBeInstanceOf(Date);
  });

  it('does not track updatedAt (append-only design)', async () => {
    const { assignee, task } = await makeTaskAndUser();

    const update = await TaskUpdate.create({
      taskId: task._id,
      updatedBy: assignee._id,
      description: 'Some progress.',
      completionPercent: 10,
    });

    expect(update.toObject()).not.toHaveProperty('updatedAt');
  });

  it('requires taskId, updatedBy, description, and completionPercent', async () => {
    await expect(TaskUpdate.create({})).rejects.toThrow();
  });

  it('bounds completionPercent to 0-100', async () => {
    const { assignee, task } = await makeTaskAndUser();

    await expect(
      TaskUpdate.create({
        taskId: task._id,
        updatedBy: assignee._id,
        description: 'Invalid %',
        completionPercent: 101,
      })
    ).rejects.toThrow();
  });

  it('accepts an optional attachment reference', async () => {
    const { assignee, task } = await makeTaskAndUser();

    const update = await TaskUpdate.create({
      taskId: task._id,
      updatedBy: assignee._id,
      description: 'With attachment',
      completionPercent: 50,
      attachment: { driveFileId: '1AbC', fileName: 'receipt.jpg', url: 'https://drive.google.com/x' },
    });

    expect(update.attachment.driveFileId).toBe('1AbC');
  });

  it('is append-only: multiple updates for the same task all persist independently, none overwritten', async () => {
    const { assignee, task } = await makeTaskAndUser();

    const first = await TaskUpdate.create({
      taskId: task._id,
      updatedBy: assignee._id,
      description: 'First entry',
      completionPercent: 20,
    });
    const second = await TaskUpdate.create({
      taskId: task._id,
      updatedBy: assignee._id,
      description: 'Second entry',
      completionPercent: 60,
    });

    const history = await TaskUpdate.find({ taskId: task._id }).sort({ createdAt: 1 });
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe(first.id);
    expect(history[0].completionPercent).toBe(20); // untouched by the later entry
    expect(history[1].id).toBe(second.id);
    expect(history[1].completionPercent).toBe(60);
  });
});
