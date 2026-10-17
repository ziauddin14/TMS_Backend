const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const ActivityEvent = require('../../src/models/ActivityEvent');
const AppSetting = require('../../src/models/AppSetting');
const activityService = require('../../src/services/activity.service');
const appSettingService = require('../../src/services/appSetting.service');

beforeAll(async () => connect());
afterEach(async () => {
  jest.restoreAllMocks();
  await activityService.flushForTests();
  await clearDatabase();
  appSettingService.resetCacheForTests();
});
afterAll(async () => closeDatabase());

const MIN = 60 * 1000;
const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
let n = 0;
async function makeUser(overrides = {}) {
  n += 1;
  return User.create({ name: `U${n}`, email: `u${n}-${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', ...overrides });
}
const reqFor = (user, headers = { 'user-agent': CHROME_WINDOWS }) => ({ user: user ? { id: user.id, role: user.role } : undefined, headers });
const raw = (user) => User.collection.findOne({ _id: user._id });

describe('activity.service — record()', () => {
  it('stores the event for the signed-in person with the parsed device only — no IP, no raw user agent', async () => {
    const user = await makeUser();
    activityService.record({ ...reqFor(user), ip: '203.0.113.9' }, 'TASK_CLOSED', { metadata: { taskCode: '261001' } });
    await activityService.flushForTests();

    const [event] = await ActivityEvent.collection.find({}).toArray();
    expect(String(event.user)).toBe(user.id);
    expect(event.type).toBe('TASK_CLOSED');
    expect(event.metadata).toEqual({ taskCode: '261001' });
    expect(event.device).toEqual({ browser: 'Chrome', os: 'Windows', deviceType: 'desktop' });
    expect(Object.keys(event).sort()).toEqual(['__v', '_id', 'at', 'device', 'metadata', 'taskId', 'type', 'user'].sort());
    expect(JSON.stringify(event)).not.toContain('203.0.113.9');
    expect(JSON.stringify(event)).not.toContain('Mozilla');
  });

  it('records nothing without a signed-in person (scripts, the cron calls)', async () => {
    activityService.record({ headers: {} }, 'REMINDERS_TRIGGERED');
    activityService.record(undefined, 'LOGIN');
    await activityService.flushForTests();
    expect(await ActivityEvent.countDocuments()).toBe(0);
  });

  it('keeps metadata small and safe: scalars and short lists only, long text cut, objects dropped', () => {
    const long = 'x'.repeat(500);
    expect(
      activityService.sanitizeMetadata({ taskCode: '261001', fields: ['title', 'deadline'], nested: { message: 'secret' }, text: long, count: 3, flag: true })
    ).toEqual({ taskCode: '261001', fields: ['title', 'deadline'], text: 'x'.repeat(80), count: 3, flag: true });
  });

  it('a failing write is logged and swallowed — record() never throws', async () => {
    const user = await makeUser();
    jest.spyOn(ActivityEvent, 'create').mockRejectedValue(new Error('database down'));
    expect(() => activityService.record(reqFor(user), 'TASK_CLOSED')).not.toThrow();
    await expect(activityService.flushForTests()).resolves.toBeUndefined();
  });
});

describe('activity.service — last active (throttled) and login', () => {
  it('the first touch writes lastActiveAt; another within 10 minutes writes nothing; after 10 minutes it writes again', async () => {
    const user = await makeUser();
    const t0 = new Date('2026-10-17T05:00:00.000Z');
    const updateSpy = jest.spyOn(User, 'updateOne');

    activityService.touchLastActive(await User.findById(user._id), t0);
    await activityService.flushForTests();
    expect((await raw(user)).lastActiveAt).toEqual(t0);

    activityService.touchLastActive(await User.findById(user._id), new Date(t0.getTime() + 9 * MIN));
    await activityService.flushForTests();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect((await raw(user)).lastActiveAt).toEqual(t0);

    const t2 = new Date(t0.getTime() + 11 * MIN);
    activityService.touchLastActive(await User.findById(user._id), t2);
    await activityService.flushForTests();
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect((await raw(user)).lastActiveAt).toEqual(t2);
  });

  it('never moves updatedAt', async () => {
    const user = await makeUser();
    const before = (await raw(user)).updatedAt;
    activityService.touchLastActive(user, new Date(Date.now() + 60 * MIN));
    await activityService.flushForTests();
    expect((await raw(user)).updatedAt).toEqual(before);
  });

  it('is atomic: two requests with the same stale copy of the user write only once', async () => {
    const user = await makeUser({});
    await User.collection.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date('2026-10-01T00:00:00.000Z') } });
    const stale = await User.findById(user._id);
    const t1 = new Date('2026-10-17T05:00:00.000Z');
    const t2 = new Date('2026-10-17T05:00:00.500Z');

    activityService.touchLastActive(stale, t1);
    await activityService.flushForTests();
    activityService.touchLastActive(stale, t2); // same stale copy — the conditional update must not match
    await activityService.flushForTests();

    expect((await raw(user)).lastActiveAt).toEqual(t1);
  });

  it('recordLogin sets lastLoginAt and lastActiveAt and records LOGIN with the device', async () => {
    const user = await makeUser();
    const now = new Date('2026-10-17T05:00:00.000Z');
    activityService.recordLogin(user, reqFor(null, { 'user-agent': CHROME_WINDOWS }), now);
    await activityService.flushForTests();

    const stored = await raw(user);
    expect(stored.lastLoginAt).toEqual(now);
    expect(stored.lastActiveAt).toEqual(now);
    const [event] = await ActivityEvent.find({ user: user._id }).lean();
    expect(event.type).toBe('LOGIN');
    expect(event.device.browser).toBe('Chrome');
  });
});

describe('appSetting.service — baseline and inactivity days', () => {
  it('the baseline is written once: concurrent first calls all get the same moment, one document', async () => {
    const results = await Promise.all([
      appSettingService.ensureActivityBaseline(new Date('2026-10-17T05:00:00.000Z')),
      (async () => {
        appSettingService.resetCacheForTests();
        return appSettingService.ensureActivityBaseline(new Date('2026-10-18T05:00:00.000Z'));
      })(),
    ]);
    appSettingService.resetCacheForTests();
    const later = await appSettingService.ensureActivityBaseline(new Date('2026-12-01T00:00:00.000Z'));

    expect(await AppSetting.countDocuments({ key: 'activityBaselineAt' })).toBe(1);
    expect(results[0].getTime()).toBe(results[1].getTime());
    expect(later.getTime()).toBe(results[0].getTime());
  });

  it('inactivity days: 7 until an admin saves one; the saved value afterwards', async () => {
    expect(await appSettingService.getInactivityDays()).toBe(7);
    const admin = await makeUser({ role: 'admin' });
    expect(await appSettingService.setInactivityDays(14, admin._id)).toEqual({ previous: 7, current: 14 });
    expect(await appSettingService.getInactivityDays()).toBe(14);
  });
});

describe('ActivityEvent — indexes', () => {
  it('has the timeline index and the one-year TTL index on `at`', async () => {
    await ActivityEvent.init();
    const indexes = await ActivityEvent.collection.indexes();
    const ttl = indexes.find((index) => JSON.stringify(index.key) === JSON.stringify({ at: 1 }));
    expect(ttl.expireAfterSeconds).toBe(365 * 24 * 60 * 60);
    expect(indexes.some((index) => JSON.stringify(index.key) === JSON.stringify({ user: 1, at: -1 }))).toBe(true);
  });
});
