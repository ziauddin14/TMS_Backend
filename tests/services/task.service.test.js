const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const LookupList = require('../../src/models/LookupList');
const Task = require('../../src/models/Task');
const taskService = require('../../src/services/task.service');

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
async function makeLookup(value = 'Donation Box Incharge', overrides = {}) {
  return LookupList.create({ listType: 'responsibility', value, ...overrides });
}
function inDays(n) {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

describe('taskService.createTask', () => {
  it('creates a task with 1 assignee, generating a codeNumber and computing timeStatus immediately', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();

    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'Collect boxes', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) }
    );

    expect(task.codeNumber).toMatch(/^\d{6}$/);
    expect(task.status).toBe('ongoing');
    expect(task.completionPercent).toBe(0);
    expect(task.performanceRating).toBe('-');
    // timeStatus is a Mongoose subdocument, not a plain object — compare fields individually
    // rather than via toEqual(plainObject), which chokes on Mongoose subdocument internals.
    expect(task.timeStatus.type).toBe('remaining');
    expect(task.timeStatus.days).toBe(5);
    expect(task.assignees).toHaveLength(1);
    expect(task.createdBy.id).toBe(admin.id);
  });

  it('creates a task with 3 assignees', async () => {
    const admin = await makeAdmin();
    const [a1, a2, a3] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const lookup = await makeLookup();

    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'Multi', assignees: [a1._id, a2._id, a3._id], responsibility: lookup.value, deadline: inDays(1) }
    );

    expect(task.assignees).toHaveLength(3);
  });

  it('rejects an assignee id that does not exist, listing it in details', async () => {
    const admin = await makeAdmin();
    const lookup = await makeLookup();
    const fakeId = new mongoose.Types.ObjectId().toString();

    await expect(
      taskService.createTask(
        { id: admin.id },
        { title: 'X', assignees: [fakeId], responsibility: lookup.value, deadline: inDays(1) }
      )
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      details: [expect.objectContaining({ field: 'assignees', message: expect.stringContaining(fakeId) })],
    });
  });

  it('rejects an inactive assignee id', async () => {
    const admin = await makeAdmin();
    const inactive = await makeUser({ isActive: false });
    const lookup = await makeLookup();

    await expect(
      taskService.createTask(
        { id: admin.id },
        { title: 'X', assignees: [inactive._id], responsibility: lookup.value, deadline: inDays(1) }
      )
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a malformed assignee id without crashing with a raw CastError', async () => {
    const admin = await makeAdmin();
    const lookup = await makeLookup();

    await expect(
      taskService.createTask(
        { id: admin.id },
        { title: 'X', assignees: ['not-an-object-id'], responsibility: lookup.value, deadline: inDays(1) }
      )
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // Responsibility is plain free text sourced from Users, not a LookupList-gated value (client's
  // Part C architecture decision) — a value with no matching LookupList entry, or none at all,
  // must be accepted rather than rejected.
  it('accepts a responsibility value with no matching (or no) LookupList entry', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();

    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: 'Not In Any Lookup List', deadline: inDays(1) }
    );

    expect(task.responsibility).toBe('Not In Any Lookup List');
  });

  it('generates sequential, unique code numbers for back-to-back creates (Counter regression check)', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const base = { assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(1) };

    const t1 = await taskService.createTask({ id: admin.id }, { ...base, title: 'A' });
    const t2 = await taskService.createTask({ id: admin.id }, { ...base, title: 'B' });

    expect(t1.codeNumber).not.toBe(t2.codeNumber);
    expect(Number(t2.codeNumber)).toBe(Number(t1.codeNumber) + 1);
  });
});

describe('taskService.listTasks (scoping and filters)', () => {
  it('forces assignees to the requesting user for role:user, ignoring a spoofed assigneeId', async () => {
    const admin = await makeAdmin();
    const me = await makeUser();
    const otherUser = await makeUser();
    const lookup = await makeLookup();

    const myTask = await taskService.createTask(
      { id: admin.id },
      { title: 'Mine', assignees: [me._id], responsibility: lookup.value, deadline: inDays(1) }
    );
    await taskService.createTask(
      { id: admin.id },
      { title: 'Not mine', assignees: [otherUser._id], responsibility: lookup.value, deadline: inDays(1) }
    );

    const result = await taskService.listTasks(
      { id: me.id, role: 'user' },
      { assigneeId: otherUser.id },
      { page: 1, limit: 20 }
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(myTask.id);
  });

  it('an Admin can filter by an arbitrary assigneeId', async () => {
    const admin = await makeAdmin();
    const target = await makeUser();
    const other = await makeUser();
    const lookup = await makeLookup();

    await taskService.createTask(
      { id: admin.id },
      { title: 'Target', assignees: [target._id], responsibility: lookup.value, deadline: inDays(1) }
    );
    await taskService.createTask(
      { id: admin.id },
      { title: 'Other', assignees: [other._id], responsibility: lookup.value, deadline: inDays(1) }
    );

    const result = await taskService.listTasks(
      { id: admin.id, role: 'admin' },
      { assigneeId: target.id },
      { page: 1, limit: 20 }
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('Target');
  });

  it('filters individually by status, responsibility, search-on-title, search-on-codeNumber, and date ranges', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookupAlpha = await makeLookup('Alpha Role');
    const lookupBeta = await makeLookup('Beta Role');

    const t1 = await taskService.createTask(
      { id: admin.id },
      { title: 'Findable Title', assignees: [assignee._id], responsibility: lookupAlpha.value, deadline: inDays(1) }
    );
    await taskService.createTask(
      { id: admin.id },
      { title: 'Other Task', assignees: [assignee._id], responsibility: lookupBeta.value, deadline: inDays(20) }
    );

    const byResp = await taskService.listTasks(
      { id: admin.id, role: 'admin' },
      { responsibility: 'Alpha Role' },
      { page: 1, limit: 20 }
    );
    expect(byResp.items).toHaveLength(1);
    expect(byResp.items[0].id).toBe(t1.id);

    const bySearchTitle = await taskService.listTasks(
      { id: admin.id, role: 'admin' },
      { search: 'findable' },
      { page: 1, limit: 20 }
    );
    expect(bySearchTitle.items).toHaveLength(1);
    expect(bySearchTitle.items[0].id).toBe(t1.id);

    const bySearchCode = await taskService.listTasks(
      { id: admin.id, role: 'admin' },
      { search: t1.codeNumber },
      { page: 1, limit: 20 }
    );
    expect(bySearchCode.items).toHaveLength(1);
    expect(bySearchCode.items[0].id).toBe(t1.id);

    const byStatus = await taskService.listTasks(
      { id: admin.id, role: 'admin' },
      { status: 'ongoing' },
      { page: 1, limit: 20 }
    );
    expect(byStatus.items).toHaveLength(2);

    const byDeadlineRange = await taskService.listTasks(
      { id: admin.id, role: 'admin' },
      { deadlineFrom: inDays(10), deadlineTo: inDays(30) },
      { page: 1, limit: 20 }
    );
    expect(byDeadlineRange.items).toHaveLength(1);
    expect(byDeadlineRange.items[0].title).toBe('Other Task');

    const byEntryRange = await taskService.listTasks(
      { id: admin.id, role: 'admin' },
      { entryFrom: inDays(-1), entryTo: inDays(1) },
      { page: 1, limit: 20 }
    );
    expect(byEntryRange.items).toHaveLength(2); // both created "now"
  });

  it('filters by performanceRating, including the "-" (not applicable) bucket (Phase 7 gap-fill: previously untested)', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();

    const excellentTask = await taskService.createTask(
      { id: admin.id },
      { title: 'Excellent Task', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) }
    );
    await Task.findByIdAndUpdate(excellentTask.id, { completionPercent: 95 });
    await taskService.closeTask({ id: admin.id }, excellentTask.id); // -> performanceRating 'excellent'

    await taskService.createTask(
      { id: admin.id },
      { title: 'Still Ongoing', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) }
    ); // performanceRating stays '-'

    const excellentResult = await taskService.listTasks(
      { id: admin.id, role: 'admin' },
      { performanceRating: 'excellent' },
      { page: 1, limit: 20 }
    );
    expect(excellentResult.items).toHaveLength(1);
    expect(excellentResult.items[0].id).toBe(excellentTask.id);

    const notApplicableResult = await taskService.listTasks(
      { id: admin.id, role: 'admin' },
      { performanceRating: '-' },
      { page: 1, limit: 20 }
    );
    expect(notApplicableResult.items).toHaveLength(1);
    expect(notApplicableResult.items[0].title).toBe('Still Ongoing');
  });

  it('sortOrder:desc reverses the sort direction (Phase 7 gap-fill: only asc was previously tested)', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    await taskService.createTask(
      { id: admin.id },
      { title: 'Early', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(1) }
    );
    await taskService.createTask(
      { id: admin.id },
      { title: 'Late', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(10) }
    );

    const result = await taskService.listTasks(
      { id: admin.id, role: 'admin' },
      {},
      { page: 1, limit: 1, sortBy: 'deadline', sortOrder: 'desc' }
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('Late'); // furthest deadline first, descending
  });

  it('combines multiple filters at once', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();

    const match = await taskService.createTask(
      { id: admin.id },
      { title: 'Combo Alpha', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(1) }
    );
    await taskService.createTask(
      { id: admin.id },
      { title: 'Combo Beta', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(1) }
    );

    const result = await taskService.listTasks(
      { id: admin.id, role: 'admin' },
      { status: 'ongoing', responsibility: lookup.value, search: 'Alpha' },
      { page: 1, limit: 20 }
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(match.id);
  });

  it('paginates and sorts', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    await taskService.createTask(
      { id: admin.id },
      { title: 'Early', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(1) }
    );
    await taskService.createTask(
      { id: admin.id },
      { title: 'Late', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(10) }
    );

    const result = await taskService.listTasks(
      { id: admin.id, role: 'admin' },
      {},
      { page: 1, limit: 1, sortBy: 'deadline', sortOrder: 'asc' }
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('Early');
    expect(result.meta).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
  });
});

describe('taskService.getTaskById (ownership)', () => {
  it('an Admin can fetch any task', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(1) }
    );

    const found = await taskService.getTaskById({ id: admin.id, role: 'admin' }, task.id);
    expect(found.id).toBe(task.id);
  });

  it('an assigned User can fetch the task', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(1) }
    );

    const found = await taskService.getTaskById({ id: assignee.id, role: 'user' }, task.id);
    expect(found.id).toBe(task.id);
  });

  it('a non-assigned User is rejected with FORBIDDEN_NOT_ASSIGNEE', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const outsider = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(1) }
    );

    await expect(taskService.getTaskById({ id: outsider.id, role: 'user' }, task.id)).rejects.toMatchObject({
      code: 'FORBIDDEN_NOT_ASSIGNEE',
      statusCode: 403,
    });
  });

  it('returns TASK_NOT_FOUND for a malformed id', async () => {
    const admin = await makeAdmin();
    await expect(taskService.getTaskById({ id: admin.id, role: 'admin' }, 'not-an-id')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('returns TASK_NOT_FOUND for a well-formed but nonexistent id', async () => {
    const admin = await makeAdmin();
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(taskService.getTaskById({ id: admin.id, role: 'admin' }, fakeId)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });
});

describe('taskService.updateTaskFields', () => {
  it('edits title/assignees/responsibility and recomputes timeStatus when deadline changes', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const newAssignee = await makeUser();
    const lookup = await makeLookup();
    const newLookup = await makeLookup('New Responsibility');

    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'Original', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(1) }
    );
    const originalDays = task.timeStatus.days;

    const updated = await taskService.updateTaskFields(task.id, {
      title: 'Renamed',
      assignees: [newAssignee._id],
      responsibility: newLookup.value,
      deadline: inDays(10),
    });

    expect(updated.title).toBe('Renamed');
    expect(updated.assignees).toHaveLength(1);
    expect(updated.assignees[0].id).toBe(newAssignee.id);
    expect(updated.responsibility).toBe('New Responsibility');
    expect(updated.timeStatus.days).toBeGreaterThan(originalDays); // deadline pushed further out
  });

  it('never touches status/completionPercent/performanceRating', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(1) }
    );

    const updated = await taskService.updateTaskFields(task.id, { title: 'Y' });

    expect(updated.status).toBe('ongoing');
    expect(updated.completionPercent).toBe(0);
    expect(updated.performanceRating).toBe('-');
  });

  it('does not recompute timeStatus if deadline was not part of the patch', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) }
    );

    const updated = await taskService.updateTaskFields(task.id, { title: 'Y' });

    expect(updated.timeStatus.type).toBe(task.timeStatus.type);
    expect(updated.timeStatus.days).toBe(task.timeStatus.days);
  });

  it('rejects an invalid new assignee the same way creation does', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(1) }
    );
    const fakeId = new mongoose.Types.ObjectId().toString();

    await expect(taskService.updateTaskFields(task.id, { assignees: [fakeId] })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('accepts a responsibility value on update with no matching (or no) LookupList entry', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(1) }
    );

    const updated = await taskService.updateTaskFields(task.id, { responsibility: 'Not In Any Lookup List' });
    expect(updated.responsibility).toBe('Not In Any Lookup List');
  });

  it('returns TASK_NOT_FOUND for a nonexistent id', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(taskService.updateTaskFields(fakeId, { title: 'X' })).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('rejects any edit on an already-closed task — read-only, checked before any field validation', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(1) }
    );
    await taskService.closeTask({ id: admin.id }, task.id);

    await expect(taskService.updateTaskFields(task.id, { title: 'Renamed after close' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      message: 'Yeh kaam close ho chuka hai',
    });

    // Even an otherwise-invalid patch (bogus responsibility) still fails with the closed-task
    // rejection, not a responsibility-validation error — proving the check runs first.
    await expect(
      taskService.updateTaskFields(task.id, { responsibility: 'Totally Bogus Value' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'Yeh kaam close ho chuka hai' });

    // Confirm the task itself is genuinely untouched.
    const unchanged = await Task.findById(task.id);
    expect(unchanged.title).toBe('X');
  });
});

describe('taskService.closeTask', () => {
  it('closes a task completed >=90% on time -> excellent, and recomputes timeStatus/performanceRating', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) }
    );
    await Task.findByIdAndUpdate(task.id, { completionPercent: 95 });

    const closed = await taskService.closeTask({ id: admin.id }, task.id);

    expect(closed.status).toBe('closed');
    expect(closed.closedBy.toString()).toBe(admin.id); // closedBy is a raw ObjectId, not populated
    expect(closed.closedAt).not.toBeNull();
    expect(closed.timeStatus.type).toBe('early');
    expect(closed.performanceRating).toBe('excellent');
  });

  it('closes a task completed at 95% but late -> downgraded to good', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(-2) }
    );
    await Task.findByIdAndUpdate(task.id, { completionPercent: 95 });

    const closed = await taskService.closeTask({ id: admin.id }, task.id);

    expect(closed.timeStatus.type).toBe('late');
    expect(closed.performanceRating).toBe('good');
  });

  it('closes a task at 40% with ZERO prior updates -> a real performanceRating (weak), proving the closedAt fallback does not crash', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(-1) }
    );
    await Task.findByIdAndUpdate(task.id, { completionPercent: 40 });
    expect(task.lastUpdateAt).toBeNull(); // confirms the "zero prior updates" precondition

    const closed = await taskService.closeTask({ id: admin.id }, task.id);

    expect(closed.lastUpdateAt).toBeNull();
    expect(closed.performanceRating).toBe('weak');
    expect(closed.timeStatus.type).toBe('late'); // deadline was already in the past at close time
  });

  it('has no reopen path — status stays closed and no such service function exists', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(1) }
    );

    const closed = await taskService.closeTask({ id: admin.id }, task.id);

    expect(closed.status).toBe('closed');
    expect(taskService.reopenTask).toBeUndefined();
  });

  it('returns TASK_NOT_FOUND for a nonexistent id', async () => {
    const admin = await makeAdmin();
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(taskService.closeTask({ id: admin.id }, fakeId)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });
});
