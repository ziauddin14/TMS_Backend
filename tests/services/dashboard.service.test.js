const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const LookupList = require('../../src/models/LookupList');
const Task = require('../../src/models/Task');
const taskService = require('../../src/services/task.service');
const taskUpdateService = require('../../src/services/taskUpdate.service');
const dashboardService = require('../../src/services/dashboard.service');

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

function sumCounts(breakdown) {
  return Object.values(breakdown).reduce((sum, bucket) => sum + bucket.count, 0);
}

describe('dashboardService.getDashboardSummary — response shape and full bucket coverage', () => {
  it("matches docs/05-apis.md §8's exact shape and spans all 4 statuses and all 5 performance buckets", async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const base = { assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) };

    // 1) ongoing, untouched -> '-'
    await taskService.createTask({ id: admin.id }, { ...base, title: 'Ongoing' });

    // 2) pending — no cron job exists yet (Phase 9) to auto-flip this, so set directly as a
    // fixture precondition, exactly as the aggregation would see it once that job exists.
    const pendingTask = await taskService.createTask({ id: admin.id }, { ...base, title: 'Pending' });
    await Task.findByIdAndUpdate(pendingTask.id, { status: 'pending' });

    // 3) complete via a real 100% update -> 'excellent' (on time)
    const completeTask = await taskService.createTask({ id: admin.id }, { ...base, title: 'Complete' });
    await taskUpdateService.createUpdate({ id: admin.id, role: 'admin' }, completeTask.id, {
      description: 'Done',
      completionPercent: 100,
    });

    // 4) closed at 85% on time -> 'good'
    const goodTask = await taskService.createTask({ id: admin.id }, { ...base, title: 'Good' });
    await Task.findByIdAndUpdate(goodTask.id, { completionPercent: 85 });
    await taskService.closeTask({ id: admin.id }, goodTask.id);

    // 5) closed at 75% on time -> 'fair'
    const fairTask = await taskService.createTask({ id: admin.id }, { ...base, title: 'Fair' });
    await Task.findByIdAndUpdate(fairTask.id, { completionPercent: 75 });
    await taskService.closeTask({ id: admin.id }, fairTask.id);

    // 6) closed at 50% on time -> 'weak'
    const weakTask = await taskService.createTask({ id: admin.id }, { ...base, title: 'Weak' });
    await Task.findByIdAndUpdate(weakTask.id, { completionPercent: 50 });
    await taskService.closeTask({ id: admin.id }, weakTask.id);

    const summary = await dashboardService.getDashboardSummary({ id: admin.id, role: 'admin' });

    expect(summary).toEqual({
      byStatus: {
        ongoing: { count: 1, percent: 17 },
        pending: { count: 1, percent: 17 },
        complete: { count: 1, percent: 17 },
        closed: { count: 3, percent: 50 },
      },
      byPerformance: {
        excellent: { count: 1, percent: 17 },
        good: { count: 1, percent: 17 },
        fair: { count: 1, percent: 17 },
        weak: { count: 1, percent: 17 },
        notApplicable: { count: 2, percent: 33 },
      },
      total: 6,
    });

    // total equals the sum of byStatus counts, and separately the sum of byPerformance counts.
    expect(sumCounts(summary.byStatus)).toBe(summary.total);
    expect(sumCounts(summary.byPerformance)).toBe(summary.total);
  });
});

describe('dashboardService.getDashboardSummary — RBAC scoping (docs/06-backend.md §4.1)', () => {
  it("a User's summary reflects only their own assigned tasks, never another user's", async () => {
    const admin = await makeAdmin();
    const me = await makeUser();
    const otherUser = await makeUser();
    const lookup = await makeLookup();

    // My task: 1 ongoing.
    await taskService.createTask(
      { id: admin.id },
      { title: 'Mine', assignees: [me._id], responsibility: lookup.value, deadline: inDays(5) }
    );

    // Another user's tasks: different statuses that must NOT leak into my totals.
    const otherTask1 = await taskService.createTask(
      { id: admin.id },
      { title: 'Not mine 1', assignees: [otherUser._id], responsibility: lookup.value, deadline: inDays(5) }
    );
    await taskUpdateService.createUpdate({ id: admin.id, role: 'admin' }, otherTask1.id, {
      description: 'Done',
      completionPercent: 100,
    });
    const otherTask2 = await taskService.createTask(
      { id: admin.id },
      { title: 'Not mine 2', assignees: [otherUser._id], responsibility: lookup.value, deadline: inDays(5) }
    );
    await taskService.closeTask({ id: admin.id }, otherTask2.id);

    const mySummary = await dashboardService.getDashboardSummary({ id: me.id, role: 'user' });
    expect(mySummary.total).toBe(1);
    expect(mySummary.byStatus).toEqual({
      ongoing: { count: 1, percent: 100 },
      pending: { count: 0, percent: 0 },
      complete: { count: 0, percent: 0 },
      closed: { count: 0, percent: 0 },
    });

    // Meanwhile the Admin's org-wide view sees all 3 tasks.
    const adminSummary = await dashboardService.getDashboardSummary({ id: admin.id, role: 'admin' });
    expect(adminSummary.total).toBe(3);
  });

  it('a User assigned alongside others on a shared task still sees it in their own summary', async () => {
    const admin = await makeAdmin();
    const me = await makeUser();
    const colleague = await makeUser();
    const lookup = await makeLookup();

    await taskService.createTask(
      { id: admin.id },
      { title: 'Shared', assignees: [me._id, colleague._id], responsibility: lookup.value, deadline: inDays(5) }
    );

    const mySummary = await dashboardService.getDashboardSummary({ id: me.id, role: 'user' });
    expect(mySummary.total).toBe(1);
  });
});

describe('dashboardService.getDashboardSummary — empty state', () => {
  it('returns all-zero counts and percents for a User with no tasks at all, no NaN/crash', async () => {
    const lonelyUser = await makeUser();

    const summary = await dashboardService.getDashboardSummary({ id: lonelyUser.id, role: 'user' });

    expect(summary.total).toBe(0);
    Object.values(summary.byStatus).forEach((bucket) => {
      expect(bucket).toEqual({ count: 0, percent: 0 });
    });
    Object.values(summary.byPerformance).forEach((bucket) => {
      expect(bucket).toEqual({ count: 0, percent: 0 });
    });
  });

  it('returns all-zero counts for an Admin when the org has zero tasks', async () => {
    const admin = await makeAdmin();
    const summary = await dashboardService.getDashboardSummary({ id: admin.id, role: 'admin' });
    expect(summary.total).toBe(0);
    expect(summary.byStatus.ongoing).toEqual({ count: 0, percent: 0 });
  });
});

describe('dashboardService.getDashboardSummary — percent rounding', () => {
  it('rounds via Math.round and percentages need not sum to exactly 100 (documented, expected)', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();

    async function makeRawTask(status) {
      return Task.create({
        codeNumber: new mongoose.Types.ObjectId().toString(),
        title: 'Fixture',
        assignees: [assignee._id],
        responsibility: lookup.value,
        deadline: inDays(5),
        createdBy: admin._id,
        status,
      });
    }

    // 7 tasks: 1 ongoing, 1 pending, 1 complete, 4 closed.
    // 1/7 = 14.28...% -> 14 (x3), 4/7 = 57.14...% -> 57. Sum = 14+14+14+57 = 99, not 100.
    await makeRawTask('ongoing');
    await makeRawTask('pending');
    await makeRawTask('complete');
    await makeRawTask('closed');
    await makeRawTask('closed');
    await makeRawTask('closed');
    await makeRawTask('closed');

    const summary = await dashboardService.getDashboardSummary({ id: admin.id, role: 'admin' });

    expect(summary.total).toBe(7);
    expect(summary.byStatus.ongoing).toEqual({ count: 1, percent: 14 });
    expect(summary.byStatus.pending).toEqual({ count: 1, percent: 14 });
    expect(summary.byStatus.complete).toEqual({ count: 1, percent: 14 });
    expect(summary.byStatus.closed).toEqual({ count: 4, percent: 57 });

    const percentSum = Object.values(summary.byStatus).reduce((sum, s) => sum + s.percent, 0);
    expect(percentSum).toBe(99); // expected rounding artifact, not a bug
  });
});
