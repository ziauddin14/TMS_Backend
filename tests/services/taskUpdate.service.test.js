const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const LookupList = require('../../src/models/LookupList');
const Task = require('../../src/models/Task');
const TaskUpdate = require('../../src/models/TaskUpdate');
const taskService = require('../../src/services/task.service');
const taskUpdateService = require('../../src/services/taskUpdate.service');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

async function makeAdmin() {
  return User.create({
    name: 'Admin',
    email: `admin${new mongoose.Types.ObjectId()}@x.com`,
    responsibility: 'Admin',
    role: 'admin',
  });
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
async function makeLookup(value = 'Donation Box Incharge') {
  return LookupList.create({ listType: 'responsibility', value });
}
function inDays(n) {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}
async function makeTask({ admin, assignees, deadlineDays = 5 }) {
  const lookup = await makeLookup();
  return taskService.createTask(
    { id: admin.id },
    { title: 'Task', assignees: assignees.map((u) => u._id), responsibility: lookup.value, deadline: inDays(deadlineDays) }
  );
}

describe('taskUpdateService.createUpdate — recalculation (docs/06-backend.md §4.5)', () => {
  it('recalculates completionPercent/lastUpdateAt/timeStatus on the parent task, confirmed both in the response and a follow-up read', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const task = await makeTask({ admin, assignees: [assignee] });
    expect(task.lastUpdateAt).toBeNull();

    const { update, task: returnedTask } = await taskUpdateService.createUpdate(
      { id: assignee.id, role: 'user' },
      task.id,
      { description: 'Some progress', completionPercent: 40 }
    );

    expect(update.completionPercent).toBe(40);
    expect(returnedTask.completionPercent).toBe(40);
    expect(returnedTask.lastUpdateAt).not.toBeNull();
    expect(returnedTask.status).toBe('ongoing'); // not yet 100%
    expect(returnedTask.performanceRating).toBe('-'); // not finished yet

    const refetched = await taskService.getTaskById({ id: admin.id, role: 'admin' }, task.id);
    expect(refetched.completionPercent).toBe(40);
    expect(refetched.lastUpdateAt).not.toBeNull();
  });

  it('an update that pushes completionPercent to 100 flips status to complete and computes a real performanceRating', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const task = await makeTask({ admin, assignees: [assignee], deadlineDays: 5 }); // deadline in the future

    const { task: updated } = await taskUpdateService.createUpdate(
      { id: assignee.id, role: 'user' },
      task.id,
      { description: 'Done', completionPercent: 100 }
    );

    expect(updated.status).toBe('complete');
    expect(updated.timeStatus.type).toBe('early'); // completed before the deadline
    expect(updated.performanceRating).toBe('excellent');
  });

  it('a second, later update from a different assignee overwrites completionPercent (last-write-wins), while the first update record stays visible and unchanged in history', async () => {
    const admin = await makeAdmin();
    const assigneeA = await makeUser();
    const assigneeB = await makeUser();
    const task = await makeTask({ admin, assignees: [assigneeA, assigneeB] });

    const first = await taskUpdateService.createUpdate(
      { id: assigneeA.id, role: 'user' },
      task.id,
      { description: 'First entry', completionPercent: 30 }
    );
    const second = await taskUpdateService.createUpdate(
      { id: assigneeB.id, role: 'user' },
      task.id,
      { description: 'Second entry', completionPercent: 70 }
    );

    expect(second.task.completionPercent).toBe(70); // official value: last write wins

    const { items: history } = await taskUpdateService.listUpdates(
      { id: admin.id, role: 'admin' },
      task.id,
      { page: 1, limit: 20 }
    );
    expect(history).toHaveLength(2);
    const firstInHistory = history.find((h) => h.id === first.update.id);
    expect(firstInHistory.completionPercent).toBe(30); // untouched by the later update
    expect(firstInHistory.description).toBe('First entry');
    const secondInHistory = history.find((h) => h.id === second.update.id);
    expect(secondInHistory.completionPercent).toBe(70);
  });
});

describe('taskUpdateService.createUpdate — access control and closed-task rejection', () => {
  it('rejects a non-assignee User with FORBIDDEN_NOT_ASSIGNEE', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const outsider = await makeUser();
    const task = await makeTask({ admin, assignees: [assignee] });

    await expect(
      taskUpdateService.createUpdate({ id: outsider.id, role: 'user' }, task.id, {
        description: 'X',
        completionPercent: 10,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN_NOT_ASSIGNEE', statusCode: 403 });
  });

  it('allows an Admin to post on any task, even one they are not assigned to', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const task = await makeTask({ admin, assignees: [assignee] });

    const { task: updated } = await taskUpdateService.createUpdate({ id: admin.id, role: 'admin' }, task.id, {
      description: 'Admin note',
      completionPercent: 20,
    });
    expect(updated.completionPercent).toBe(20);
  });

  it('rejects POST on a closed task with VALIDATION_ERROR, "Yeh kaam close ho chuka hai"', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const task = await makeTask({ admin, assignees: [assignee] });
    await taskService.closeTask({ id: admin.id }, task.id);

    await expect(
      taskUpdateService.createUpdate({ id: assignee.id, role: 'user' }, task.id, {
        description: 'Too late',
        completionPercent: 50,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400, message: 'Yeh kaam close ho chuka hai' });

    const untouched = await TaskUpdate.find({ taskId: task.id });
    expect(untouched).toHaveLength(0);
  });

  it('returns TASK_NOT_FOUND for a nonexistent task id', async () => {
    const admin = await makeAdmin();
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(
      taskUpdateService.createUpdate({ id: admin.id, role: 'admin' }, fakeId, {
        description: 'X',
        completionPercent: 10,
      })
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', statusCode: 404 });
  });

  it('returns TASK_NOT_FOUND for a malformed task id, without a raw CastError', async () => {
    const admin = await makeAdmin();
    await expect(
      taskUpdateService.createUpdate({ id: admin.id, role: 'admin' }, 'not-an-id', {
        description: 'X',
        completionPercent: 10,
      })
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });
});

describe('taskUpdateService.createUpdate — transaction atomicity', () => {
  it('rolls back both writes if the task save fails mid-transaction (no orphaned TaskUpdate, task untouched)', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const task = await makeTask({ admin, assignees: [assignee] });

    const saveSpy = jest.spyOn(Task.prototype, 'save').mockImplementationOnce(() => {
      throw new Error('forced failure for rollback test');
    });

    await expect(
      taskUpdateService.createUpdate({ id: assignee.id, role: 'user' }, task.id, {
        description: 'Should not persist',
        completionPercent: 50,
      })
    ).rejects.toThrow('forced failure for rollback test');

    saveSpy.mockRestore();

    const orphanedUpdates = await TaskUpdate.find({ taskId: task.id });
    expect(orphanedUpdates).toHaveLength(0);

    const unchangedTask = await Task.findById(task.id);
    expect(unchangedTask.completionPercent).toBe(0);
    expect(unchangedTask.lastUpdateAt).toBeNull();
  });
});

describe('taskUpdateService.listUpdates', () => {
  it('reuses task.service.js getTaskById ownership rule: non-assignee User is rejected', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const outsider = await makeUser();
    const task = await makeTask({ admin, assignees: [assignee] });

    await expect(
      taskUpdateService.listUpdates({ id: outsider.id, role: 'user' }, task.id, { page: 1, limit: 20 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN_NOT_ASSIGNEE' });
  });

  it('sorts newest-first and paginates', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const task = await makeTask({ admin, assignees: [assignee] });

    await taskUpdateService.createUpdate({ id: assignee.id, role: 'user' }, task.id, {
      description: 'Older',
      completionPercent: 10,
    });
    await taskUpdateService.createUpdate({ id: assignee.id, role: 'user' }, task.id, {
      description: 'Newer',
      completionPercent: 20,
    });

    const { items, meta } = await taskUpdateService.listUpdates(
      { id: admin.id, role: 'admin' },
      task.id,
      { page: 1, limit: 1 }
    );

    expect(items).toHaveLength(1);
    expect(items[0].description).toBe('Newer');
    expect(meta).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
  });
});
