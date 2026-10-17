const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const TaskUpdate = require('../../src/models/TaskUpdate');
const ActivityEvent = require('../../src/models/ActivityEvent');
const AppSetting = require('../../src/models/AppSetting');
const activityAdmin = require('../../src/services/activityAdmin.service');
const appSettingService = require('../../src/services/appSetting.service');

beforeAll(async () => connect());
afterEach(async () => {
  await clearDatabase();
  appSettingService.resetCacheForTests();
});
afterAll(async () => closeDatabase());

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-17T07:00:00.000Z'); // 12:00 in Pakistan
const ago = (days) => new Date(NOW.getTime() - days * DAY);

async function setBaseline(date) {
  await AppSetting.create({ key: 'activityBaselineAt', value: date });
}
let n = 0;
// A user written straight into the collection, so createdAt and the activity times are exactly as given.
async function seedUser({ createdAt = ago(400), lastActiveAt, lastLoginAt, isActive = true, role = 'user', name } = {}) {
  n += 1;
  const doc = { name: name || `User ${n}`, email: `u${n}-${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role, isActive, createdAt, updatedAt: createdAt };
  if (lastActiveAt) doc.lastActiveAt = lastActiveAt;
  if (lastLoginAt) doc.lastLoginAt = lastLoginAt;
  const { insertedId } = await User.collection.insertOne(doc);
  return { ...doc, _id: insertedId, id: String(insertedId) };
}

describe('the inactivity rule (pure)', () => {
  const ctx = (baseline, days = 7) => ({ now: NOW, baseline, days });

  it('nobody is flagged in the first N days after the baseline, even with no activity at all', () => {
    const user = { isActive: true, createdAt: ago(400) };
    expect(activityAdmin.isInactive(user, ctx(ago(6)))).toBe(false);
    expect(activityAdmin.isInactive(user, ctx(ago(7)))).toBe(false); // exactly N days: not MORE than N
    expect(activityAdmin.isInactive(user, ctx(ago(7.01)))).toBe(true);
  });

  it('a new account gets a full N days from its creation', () => {
    expect(activityAdmin.isInactive({ isActive: true, createdAt: ago(3) }, ctx(ago(60)))).toBe(false);
    expect(activityAdmin.isInactive({ isActive: true, createdAt: ago(8) }, ctx(ago(60)))).toBe(true);
  });

  it('counts from the latest of last active, last login, creation and baseline', () => {
    const base = ago(60);
    expect(activityAdmin.isInactive({ isActive: true, createdAt: ago(400), lastActiveAt: ago(2) }, ctx(base))).toBe(false);
    expect(activityAdmin.isInactive({ isActive: true, createdAt: ago(400), lastLoginAt: ago(2), lastActiveAt: ago(30) }, ctx(base))).toBe(false);
    expect(activityAdmin.isInactive({ isActive: true, createdAt: ago(400), lastActiveAt: ago(9) }, ctx(base))).toBe(true);
    expect(activityAdmin.effectiveActivityTime({ createdAt: ago(400), lastActiveAt: ago(9), lastLoginAt: ago(20) }, base)).toEqual(ago(9));
  });

  it('a deactivated account is never flagged', () => {
    expect(activityAdmin.isInactive({ isActive: false, createdAt: ago(400) }, ctx(ago(300)))).toBe(false);
  });

  it('follows the configured N', () => {
    const user = { isActive: true, createdAt: ago(400), lastActiveAt: ago(10) };
    expect(activityAdmin.isInactive(user, ctx(ago(60), 7))).toBe(true);
    expect(activityAdmin.isInactive(user, ctx(ago(60), 14))).toBe(false);
  });

  it('a Pakistan calendar day starts at 00:00+05:00', () => {
    expect(activityAdmin.karachiDayStart('2026-10-17').toISOString()).toBe('2026-10-16T19:00:00.000Z');
  });
});

describe('getSummary', () => {
  it('today = since Pakistan midnight; this week = the last 7 x 24h; inactive = flagged active accounts only', async () => {
    await setBaseline(ago(60));
    await seedUser({ lastActiveAt: new Date('2026-10-16T19:30:00.000Z') }); // 00:30 today in Pakistan
    await seedUser({ lastActiveAt: new Date('2026-10-16T18:30:00.000Z') }); // 23:30 yesterday in Pakistan
    await seedUser({ lastActiveAt: ago(6.9) }); // this week, not today
    await seedUser({ lastActiveAt: ago(8) }); // inactive
    await seedUser({ lastActiveAt: ago(30), isActive: false }); // deactivated: neither counted nor flagged

    const summary = await activityAdmin.getSummary(NOW);

    expect(summary).toMatchObject({ inactivityDays: 7, totalActive: 4, activeToday: 1, activeThisWeek: 3, inactiveCount: 1 });
    expect(new Date(summary.baselineAt)).toEqual(ago(60));
  });

  it('right after the baseline nobody is inactive', async () => {
    await setBaseline(ago(1));
    await seedUser();
    await seedUser({ lastLoginAt: ago(200) });
    expect((await activityAdmin.getSummary(NOW)).inactiveCount).toBe(0);
  });
});

describe('listUsers', () => {
  it('active accounts, admins included, most inactive first; deactivated ones only when searched — never flagged', async () => {
    await setBaseline(ago(60));
    const quiet = await seedUser({ name: 'Quiet', lastActiveAt: ago(20) });
    await seedUser({ name: 'Busy', lastActiveAt: ago(1) });
    await seedUser({ name: 'Admin One', role: 'admin', lastActiveAt: ago(9) });
    await seedUser({ name: 'Gone Away', isActive: false, lastActiveAt: ago(90) });

    const { items } = await activityAdmin.listUsers({}, NOW);
    expect(items.map((row) => row.name)).toEqual(['Quiet', 'Admin One', 'Busy']);
    expect(items.map((row) => row.isInactive)).toEqual([true, true, false]);
    expect(items[0]).toMatchObject({ id: quiet.id, daysSinceActivity: 20, noActivityRecorded: false });

    const searched = await activityAdmin.listUsers({ search: 'gone' }, NOW);
    expect(searched.items).toHaveLength(1);
    expect(searched.items[0]).toMatchObject({ name: 'Gone Away', isActive: false, isInactive: false });

    const inactiveOnly = await activityAdmin.listUsers({ inactiveOnly: true }, NOW);
    expect(inactiveOnly.items.map((row) => row.name)).toEqual(['Quiet', 'Admin One']);
  });

  it('nothing recorded since the baseline: said as such, counted from the baseline', async () => {
    await setBaseline(ago(10));
    const user = await seedUser({ createdAt: ago(400) });
    const [row] = (await activityAdmin.listUsers({}, NOW)).items;
    expect(row).toMatchObject({ id: user.id, noActivityRecorded: true, lastLoginAt: null, lastActiveAt: null, daysSinceActivity: 10, isInactive: true });
  });

  it('the last action is the person\'s latest event', async () => {
    await setBaseline(ago(60));
    const user = await seedUser({ lastActiveAt: ago(1) });
    await ActivityEvent.create({ user: user._id, type: 'LOGIN', at: ago(3) });
    await ActivityEvent.create({ user: user._id, type: 'TASK_UPDATE_CREATED', at: ago(1), metadata: { taskCode: '261001' } });
    const [row] = (await activityAdmin.listUsers({}, NOW)).items;
    expect(row.lastAction).toMatchObject({ type: 'TASK_UPDATE_CREATED', taskCode: '261001' });
  });

  it('task updates from before the baseline never feed the inactivity result', async () => {
    await setBaseline(ago(30));
    const user = await seedUser();
    const task = await Task.create({ codeNumber: '250001', title: 'T', assignees: [user._id], responsibility: 'R', deadline: NOW, createdBy: user._id });
    await TaskUpdate.collection.insertOne({ taskId: task._id, updatedBy: user._id, description: 'x', completionPercent: 50, createdAt: ago(31) });
    await TaskUpdate.collection.insertOne({ taskId: task._id, updatedBy: user._id, description: 'y', completionPercent: 60, createdAt: ago(2) });

    const [row] = (await activityAdmin.listUsers({}, NOW)).items;
    expect(row.isInactive).toBe(true);
    expect(row.daysSinceActivity).toBe(30);
    expect((await activityAdmin.historyBeforeBaseline(user.id)).items).toHaveLength(1);
  });
});

describe('listEvents and historyBeforeBaseline', () => {
  it('events: newest first, filtered by type and by whole Pakistan days, paginated', async () => {
    await setBaseline(ago(60));
    const user = await seedUser();
    const other = await seedUser();
    await ActivityEvent.create([
      { user: user._id, type: 'LOGIN', at: new Date('2026-10-15T19:30:00.000Z') }, // 16 Oct 00:30 PKT
      { user: user._id, type: 'TASK_CLOSED', at: new Date('2026-10-16T18:59:00.000Z') }, // 16 Oct 23:59 PKT
      { user: user._id, type: 'LOGIN', at: new Date('2026-10-16T19:01:00.000Z') }, // 17 Oct 00:01 PKT
      { user: other._id, type: 'LOGIN', at: new Date('2026-10-16T10:00:00.000Z') },
    ]);

    const all = await activityAdmin.listEvents(user.id, {});
    expect(all.items.map((e) => e.type)).toEqual(['LOGIN', 'TASK_CLOSED', 'LOGIN']);
    const oneDay = await activityAdmin.listEvents(user.id, { from: '2026-10-16', to: '2026-10-16' });
    expect(oneDay.items.map((e) => e.type)).toEqual(['TASK_CLOSED', 'LOGIN']);
    const logins = await activityAdmin.listEvents(user.id, { type: 'LOGIN' });
    expect(logins.meta.total).toBe(2);
    const page2 = await activityAdmin.listEvents(user.id, { page: 2, limit: 2 });
    expect(page2.items).toHaveLength(1);
    expect(page2.meta.totalPages).toBe(2);
  });

  it('history: that person\'s task updates before the baseline only — when, which task, what percent; never the text', async () => {
    await setBaseline(new Date('2026-10-10T00:00:00.000Z'));
    const user = await seedUser();
    const task = await Task.create({ codeNumber: '250002', title: 'T', assignees: [user._id], responsibility: 'R', deadline: NOW, createdBy: user._id });
    await TaskUpdate.collection.insertMany([
      { taskId: task._id, updatedBy: user._id, description: 'private words', completionPercent: 30, createdAt: new Date('2026-09-01T00:00:00.000Z') },
      { taskId: task._id, updatedBy: user._id, description: 'more', completionPercent: 70, createdAt: new Date('2026-10-12T00:00:00.000Z') },
    ]);

    const { items, meta } = await activityAdmin.historyBeforeBaseline(user.id);
    expect(items).toEqual([{ id: expect.any(String), at: new Date('2026-09-01T00:00:00.000Z'), taskCode: '250002', completionPercent: 30 }]);
    expect(JSON.stringify(items)).not.toContain('private words');
    expect(meta.total).toBe(1);
  });

  it('an unknown person is 404', async () => {
    await expect(activityAdmin.listEvents(String(new mongoose.Types.ObjectId()), {})).rejects.toMatchObject({ statusCode: 404 });
    await expect(activityAdmin.historyBeforeBaseline('nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});
