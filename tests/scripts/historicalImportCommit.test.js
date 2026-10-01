const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const TaskUpdate = require('../../src/models/TaskUpdate');
const HistoricalImportRecord = require('../../src/models/HistoricalImportRecord');
const { buildPlan } = require('../../scripts/historical-import/plan');
const { commitPlan } = require('../../scripts/historical-import/commit');

beforeAll(async () => connect());
afterEach(async () => {
  await clearDatabase();
  jest.restoreAllMocks();
});
afterAll(async () => closeDatabase());

async function makeUsers() {
  const zimmedar = await User.create({ name: 'Z', email: `z${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'user' });
  const admin = await User.create({ name: 'A', email: `a${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'رکن شوری', role: 'admin' });
  return { zimmedar, admin };
}

function planFor({ zimmedar, admin }) {
  const data = {
    alpha: {
      title: 'x',
      tasks: [
        {
          code: '250110',
          desc: 'پہلا کام',
          target: '31-Mar-25',
          close: '20-Mar-25',
          code_date: '2025-01-10',
          updates: [
            { speaker: 'zimmedar', text: 'یہ کام 40 فیصد ہوا', date_year: 2025, date_month: 2, date_day: 1 },
            { speaker: 'admin', text: 'یہ مدنی پھول کلوز ہوا۔', date_year: 2025, date_month: 3, date_day: 20, date_inherited: 'forward' },
          ],
        },
        {
          code: '250111',
          desc: 'دوسرا کام',
          target: '31-Dec-25',
          close: '',
          code_date: '2025-01-11',
          updates: [{ speaker: 'zimmedar', text: 'جاری ہے', date_year: 2025, date_month: 1, date_day: 11 }],
        },
      ],
    },
  };
  return buildPlan(data, {
    userMap: { alpha: zimmedar.id },
    adminUserId: admin.id,
    responsibilityByPerson: { alpha: 'R' },
    merges: {},
    statusOverrides: {},
    handoverCases: {},
    handoverDecisions: {},
    reminderDaysBefore: 2,
    now: new Date(Date.UTC(2026, 9, 1, 6)),
  });
}

describe('historical import — commitPlan', () => {
  it('writes the exact planned documents, preserving historical createdAt/updatedAt (not "now")', async () => {
    const users = await makeUsers();
    const plan = planFor(users);

    const result = await commitPlan(plan, { importBatch: 'test' });

    expect(result).toEqual({ tasksCreated: 2, updatesCreated: 3, tasksSkippedAlreadyImported: 0, conflicts: [] });
    const task = await Task.findOne({ codeNumber: '250110' });
    expect(task.createdAt.toISOString()).toBe('2025-01-10T00:00:00.000Z');
    expect(task.status).toBe('closed');
    expect(task.closedAt.toISOString()).toBe('2025-03-20T00:00:00.000Z');
    expect(task.completionPercent).toBe(40);
    expect(task.updatedAt.getTime()).toBe(plan.tasks[0].task.updatedAt.getTime());

    const updates = await TaskUpdate.find({ taskId: task._id }).sort({ createdAt: 1 });
    expect(updates.map((u) => u.createdAt.toISOString().slice(0, 10))).toEqual(['2025-02-01', '2025-03-20']);
    expect(updates[1].updatedBy.toString()).toBe(users.admin.id);

    const open = await Task.findOne({ codeNumber: '250111' });
    expect(open.status).toBe('pending');
  });

  it('writes one ledger record per Task and per TaskUpdate, carrying flags and raw source values', async () => {
    const plan = planFor(await makeUsers());

    await commitPlan(plan, { importBatch: 'test' });

    expect(await HistoricalImportRecord.countDocuments({ kind: 'task' })).toBe(2);
    expect(await HistoricalImportRecord.countDocuments({ kind: 'taskUpdate' })).toBe(3);
    const rec = await HistoricalImportRecord.findOne({ sourceKey: 'update:250110:1' });
    expect(rec.flags).toMatchObject({ date_inherited: 'forward', dateSource: 'inherited_forward', percentSource: 'carried_forward' });
    expect(rec.raw).toMatchObject({ speaker: 'admin', date_year: 2025, date_month: 3, date_day: 20 });
    const taskRec = await HistoricalImportRecord.findOne({ sourceKey: 'task:250110' });
    expect(taskRec.raw).toEqual({ target: '31-Mar-25', close: '20-Mar-25', code_date: '2025-01-10' });
  });

  it('is idempotent — a re-run creates nothing new', async () => {
    const plan = planFor(await makeUsers());
    await commitPlan(plan, { importBatch: 'test' });

    const second = await commitPlan(plan, { importBatch: 'test' });

    expect(second).toEqual({ tasksCreated: 0, updatesCreated: 0, tasksSkippedAlreadyImported: 2, conflicts: [] });
    expect(await Task.countDocuments({})).toBe(2);
    expect(await TaskUpdate.countDocuments({})).toBe(3);
  });

  it('never touches a live Task that already holds the same codeNumber — reports a conflict instead', async () => {
    const users = await makeUsers();
    await Task.create({
      codeNumber: '250110',
      title: 'live task',
      assignees: [users.zimmedar._id],
      responsibility: 'R',
      deadline: new Date(),
      createdBy: users.admin._id,
    });
    const plan = planFor(users);

    const result = await commitPlan(plan, { importBatch: 'test' });

    expect(result.conflicts).toEqual([expect.objectContaining({ code: '250110' })]);
    expect(result.tasksCreated).toBe(1);
    expect((await Task.findOne({ codeNumber: '250110' })).title).toBe('live task');
    expect(await HistoricalImportRecord.exists({ sourceKey: 'task:250110' })).toBeNull();
  });

  it('rolls a task back completely if any part of it fails, and a later re-run completes it', async () => {
    const plan = planFor(await makeUsers());
    const realCreate = TaskUpdate.create.bind(TaskUpdate);
    jest.spyOn(TaskUpdate, 'create').mockImplementationOnce(() => Promise.reject(new Error('simulated failure')));

    await expect(commitPlan(plan, { importBatch: 'test' })).rejects.toThrow('simulated failure');
    expect(await Task.countDocuments({})).toBe(0);
    expect(await HistoricalImportRecord.countDocuments({})).toBe(0);

    TaskUpdate.create.mockImplementation(realCreate);
    const retry = await commitPlan(plan, { importBatch: 'test' });
    expect(retry.tasksCreated).toBe(2);
    expect(await TaskUpdate.countDocuments({})).toBe(3);
  });
});
