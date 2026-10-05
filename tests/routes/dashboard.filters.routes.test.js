const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');

// GET /dashboard/summary over HTTP: it takes the same filter query params as GET /tasks, returns
// the `ratings` block, and never lets a normal user see beyond their own tasks.
beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

const tokenFor = (user) => jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
const auth = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);

async function seed() {
  const admin = await User.create({ name: 'Admin', email: `a${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'Admin', role: 'admin' });
  const userA = await User.create({ name: 'A', email: `ua${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R1', role: 'user' });
  const userB = await User.create({ name: 'B', email: `ub${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R2', role: 'user' });
  const base = (code, extra) => ({
    codeNumber: code,
    title: `task ${code}`,
    assignees: [userA._id],
    responsibility: 'R1',
    deadline: day('2026-06-30'),
    createdBy: admin._id,
    ...extra,
  });
  const syn = (assumedPercent) => ({ isSynthetic: true, assumedPercent, assignedAt: day('2026-10-05'), assignedBy: 'system:script' });
  await Task.create([
    base('260101', { status: 'closed', completionPercent: 95, performanceRating: 'excellent' }),
    base('260102', { status: 'closed', completionPercent: 0, performanceRating: 'good', syntheticRating: syn(80) }),
    base('260103', { status: 'pending', completionPercent: 20, performanceRating: 'weak', syntheticRating: syn(40) }),
    base('260104', { status: 'ongoing', completionPercent: 10 }),
    base('260201', { assignees: [userB._id], responsibility: 'R2', status: 'closed', completionPercent: 50, performanceRating: 'weak' }),
    base('260202', { assignees: [userB._id], responsibility: 'R2', status: 'ongoing', performanceRating: 'fair', syntheticRating: syn(70) }),
  ]);
  return { admin, userA, userB };
}
const summary = (user, query = '') => request(app).get(`/api/v1/dashboard/summary${query}`).set(auth(user));

describe('GET /api/v1/dashboard/summary — filters', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/dashboard/summary');
    expect(res.status).toBe(401);
  });

  it('admin, no filter: the rating KPIs over every task', async () => {
    const { admin } = await seed();

    const res = await summary(admin);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(6);
    expect(res.body.data.ratings).toEqual({
      bands: {
        excellent: { count: 1, percent: 20 },
        good: { count: 1, percent: 20 },
        fair: { count: 1, percent: 20 },
        weak: { count: 2, percent: 40 },
      },
      ratedCount: 5,
      unratedCount: 1,
      syntheticCount: 3,
      averageEffectivePercent: 67, // (95 + 80 + 40 + 50 + 70) / 5
      overallQuality: { band: 'weak', percent: 67 },
    });
  });

  it('the same query string gives the same set on /tasks and on /dashboard/summary', async () => {
    const { admin, userB } = await seed();
    const query = `?status=closed&assigneeId=${userB.id}`;

    const [kpis, list] = await Promise.all([summary(admin, query), request(app).get(`/api/v1/tasks${query}`).set(auth(admin))]);

    expect(list.body.data.map((t) => t.codeNumber)).toEqual(['260201']);
    expect(kpis.body.data.total).toBe(1);
    expect(kpis.body.data.ratings).toMatchObject({ ratedCount: 1, syntheticCount: 0, overallQuality: { band: 'weak', percent: 50 } });
  });

  it.each([
    ['?status=pending', 1, 1],
    ['?performanceRating=weak', 2, 5], // the rating filter narrows total, never the rating KPIs
    ['?ratingSource=synthetic', 3, 3],
    ['?ratingSource=real', 2, 2],
    ['?responsibility=R2', 2, 2],
    ['?search=26010', 4, 3],
    ['?deadlineFrom=2026-06-01&deadlineTo=2026-07-31', 6, 5],
    ['?entryFrom=2000-01-01&entryTo=2000-12-31', 0, 0],
  ])('%s -> %i task(s), %i rated', async (query, total, rated) => {
    const { admin } = await seed();
    const res = await summary(admin, query);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(total);
    expect(res.body.data.ratings.ratedCount).toBe(rated);
  });

  it('with a band selected, the band figures are unchanged — only the listed-set figures follow it', async () => {
    const { admin } = await seed();

    const [plain, withBand] = await Promise.all([summary(admin), summary(admin, '?performanceRating=good')]);

    expect(withBand.status).toBe(200);
    expect(withBand.body.data.ratings).toEqual(plain.body.data.ratings);
    expect(withBand.body.data.ratings.bands.weak).toEqual({ count: 2, percent: 40 });
    expect(withBand.body.data.total).toBe(1);
    expect(withBand.body.data.byPerformance.good.count).toBe(1);
    expect(withBand.body.data.byPerformance.weak.count).toBe(0);
  });

  it('a band plus another filter: the band figures follow the other filter only', async () => {
    const { admin, userB } = await seed();

    const [zimmedarOnly, zimmedarAndBand] = await Promise.all([
      summary(admin, `?assigneeId=${userB.id}`),
      summary(admin, `?assigneeId=${userB.id}&performanceRating=fair`),
    ]);

    expect(zimmedarAndBand.body.data.ratings).toEqual(zimmedarOnly.body.data.ratings);
    expect(zimmedarAndBand.body.data.ratings).toMatchObject({ ratedCount: 2, syntheticCount: 1 });
  });

  it('an empty result has no overall value (null), not zero', async () => {
    const { admin } = await seed();
    const res = await summary(admin, '?search=nothing-matches-this');
    expect(res.body.data.ratings).toMatchObject({ ratedCount: 0, unratedCount: 0, averageEffectivePercent: null, overallQuality: null });
  });

  it.each(['?page=2', '?limit=5', '?sortBy=deadline', '?bogus=1', '?status=nope', '?ratingSource=maybe'])(
    '400 for a query it does not accept: %s',
    async (query) => {
      const { admin } = await seed();
      const res = await summary(admin, query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
  );

  it('a normal user gets only their own tasks', async () => {
    const { userA } = await seed();

    const res = await summary(userA);

    expect(res.body.data.total).toBe(4);
    // real excellent 95 + synthetic good 80 + synthetic weak 40 -> 71.6 -> fair
    expect(res.body.data.ratings).toMatchObject({ ratedCount: 3, unratedCount: 1, syntheticCount: 2, overallQuality: { band: 'fair', percent: 71.6 } });
  });

  it('a normal user sending another person\'s assigneeId still gets only their own tasks', async () => {
    const { userA, userB } = await seed();

    const mine = await summary(userA);
    const sneaky = await summary(userA, `?assigneeId=${userB.id}`);

    expect(sneaky.status).toBe(200);
    expect(sneaky.body.data).toEqual(mine.body.data);
  });

  it('a normal user\'s filters narrow within their own tasks', async () => {
    const { userB } = await seed();
    const res = await summary(userB, '?status=closed');
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.ratings.overallQuality).toEqual({ band: 'weak', percent: 50 });
  });
});
