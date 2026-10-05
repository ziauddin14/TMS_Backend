const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const taskService = require('../../src/services/task.service');
const dashboardService = require('../../src/services/dashboard.service');

const { buildRatingKpis, percentsSummingTo100 } = dashboardService;

// ---- Pure maths (no database) ---------------------------------------------------------------
const real = (rating, percent) => ({ performanceRating: rating, completionPercent: percent });
const synthetic = (rating, assumedPercent, realPercent = 0) => ({
  performanceRating: rating,
  completionPercent: realPercent,
  syntheticRating: { isSynthetic: true, assumedPercent },
});
const unrated = (percent = 0) => ({ performanceRating: '-', completionPercent: percent });
const sumPercents = (kpis) => Object.values(kpis.bands).reduce((sum, band) => sum + band.percent, 0);
const repeat = (n, make) => Array.from({ length: n }, make);

describe('buildRatingKpis — the rated set and the bands', () => {
  it('with nothing rated: every band is zero and there is NO overall value (null, not 0)', () => {
    expect(buildRatingKpis([])).toEqual({
      bands: { excellent: { count: 0, percent: 0 }, good: { count: 0, percent: 0 }, fair: { count: 0, percent: 0 }, weak: { count: 0, percent: 0 } },
      ratedCount: 0,
      unratedCount: 0,
      syntheticCount: 0,
      averageEffectivePercent: null,
      overallQuality: null,
    });
  });

  it('only unrated tasks: they are counted as unrated, never as a band, and there is still no overall value', () => {
    const kpis = buildRatingKpis([unrated(), unrated(40), unrated(100)]);
    expect(kpis).toMatchObject({ ratedCount: 0, unratedCount: 3, syntheticCount: 0, averageEffectivePercent: null, overallQuality: null });
    expect(sumPercents(kpis)).toBe(0);
  });

  it('band percents are shares of the RATED set only — unrated tasks do not dilute them', () => {
    const kpis = buildRatingKpis([real('good', 85), real('weak', 10), unrated(), unrated(), unrated(), unrated()]);
    expect(kpis.bands).toEqual({
      excellent: { count: 0, percent: 0 },
      good: { count: 1, percent: 50 },
      fair: { count: 0, percent: 0 },
      weak: { count: 1, percent: 50 },
    });
    expect(kpis).toMatchObject({ ratedCount: 2, unratedCount: 4 });
  });

  it('a mixed set: real and synthetic ratings are counted together in their band; syntheticCount says how many are synthetic', () => {
    const kpis = buildRatingKpis([real('excellent', 95), real('good', 85), synthetic('good', 80), synthetic('weak', 40), unrated()]);
    expect(kpis.bands).toEqual({
      excellent: { count: 1, percent: 25 },
      good: { count: 2, percent: 50 },
      fair: { count: 0, percent: 0 },
      weak: { count: 1, percent: 25 },
    });
    expect(kpis).toMatchObject({ ratedCount: 4, unratedCount: 1, syntheticCount: 2 });
  });

  it('only synthetic ratings: all counted, all flagged', () => {
    const kpis = buildRatingKpis([synthetic('good', 80), synthetic('good', 80), synthetic('weak', 40)]);
    expect(kpis).toMatchObject({ ratedCount: 3, unratedCount: 0, syntheticCount: 3 });
    expect(kpis.bands.good).toEqual({ count: 2, percent: 67 });
    expect(kpis.bands.weak).toEqual({ count: 1, percent: 33 });
  });
});

describe('buildRatingKpis — band percents always sum to exactly 100', () => {
  it.each([
    ['three equal bands (33.3 each)', [1, 1, 1, 0]],
    ['four equal bands', [1, 1, 1, 1]],
    ['the live distribution 0 / 81 / 6 / 60', [0, 81, 6, 60]],
    ['sixths', [1, 2, 3, 0]],
    ['sevenths', [1, 1, 2, 3]],
    ['a single task', [0, 0, 0, 1]],
    ['awkward thirds', [2, 2, 2, 1]],
    ['large and tiny', [997, 1, 1, 1]],
  ])('%s', (_label, [e, g, f, w]) => {
    const tasks = [
      ...repeat(e, () => real('excellent', 95)),
      ...repeat(g, () => real('good', 85)),
      ...repeat(f, () => real('fair', 75)),
      ...repeat(w, () => real('weak', 10)),
    ];
    const kpis = buildRatingKpis(tasks);
    expect(sumPercents(kpis)).toBe(100);
    expect([kpis.bands.excellent.count, kpis.bands.good.count, kpis.bands.fair.count, kpis.bands.weak.count]).toEqual([e, g, f, w]);
  });

  it('percentsSummingTo100 gives the leftover point to the largest fractional share, earlier entries first on a tie', () => {
    expect(percentsSummingTo100([1, 1, 1])).toEqual([34, 33, 33]);
    expect(percentsSummingTo100([0, 81, 6, 60])).toEqual([0, 55, 4, 41]);
    expect(percentsSummingTo100([0, 0, 0, 0])).toEqual([0, 0, 0, 0]);
    expect(percentsSummingTo100([5, 0, 0, 0])).toEqual([100, 0, 0, 0]);
  });
});

describe('buildRatingKpis — overall quality: the plain average of the effective percent, then the thresholds', () => {
  it('uses the ASSUMED percent for a synthetic rating and the REAL completion percent for a real one', () => {
    // synthetic: assumed 80 (its real 0% is ignored) · real: 40 -> average 60 -> weak
    const kpis = buildRatingKpis([synthetic('good', 80, 0), real('weak', 40)]);
    expect(kpis.averageEffectivePercent).toBe(60);
    expect(kpis.overallQuality).toEqual({ band: 'weak', percent: 60 });
  });

  it('a synthetic rating that is no longer in force (isSynthetic false) counts at the real percent, and is not counted as synthetic', () => {
    const retired = { performanceRating: 'excellent', completionPercent: 95, syntheticRating: { isSynthetic: false, assumedPercent: 40 } };
    const kpis = buildRatingKpis([retired]);
    expect(kpis).toMatchObject({ averageEffectivePercent: 95, syntheticCount: 0 });
  });

  it('unrated tasks are not part of the average', () => {
    const kpis = buildRatingKpis([real('excellent', 100), unrated(0), unrated(0), unrated(0)]);
    expect(kpis.overallQuality).toEqual({ band: 'excellent', percent: 100 });
  });

  it.each([
    [[90], 'excellent', 90],
    [[89.9], 'good', 89.9],
    [[80], 'good', 80],
    [[79.9], 'fair', 79.9],
    [[70], 'fair', 70],
    [[69.9], 'weak', 69.9],
    [[100, 80], 'excellent', 90], // average exactly 90
    [[100, 60], 'good', 80], // average exactly 80
    [[100, 40], 'fair', 70], // average exactly 70
    [[0], 'weak', 0],
  ])('effective percents %j -> %s at %s%%', (percents, band, shown) => {
    const kpis = buildRatingKpis(percents.map((p) => real('good', p)));
    expect(kpis.overallQuality).toEqual({ band, percent: shown });
  });

  it('is not pushed across a threshold by floating-point noise in a sum of fractional percents', () => {
    // 79.47 + 80.53 is 160 in arithmetic but not in floating point; the average is exactly 80.
    const kpis = buildRatingKpis([real('fair', 79.47), real('good', 80.53)]);
    expect(kpis.overallQuality).toEqual({ band: 'good', percent: 80 });
  });

  it('shows the average truncated to one decimal, so the figure never reads as a threshold the band has not reached', () => {
    // average 89.96 -> band "good"; shown as 89.9, not rounded up to a misleading 90.0
    const kpis = buildRatingKpis([real('good', 89.96)]);
    expect(kpis.overallQuality).toEqual({ band: 'good', percent: 89.9 });
  });

  it('applies no weights and no late downgrade: just the mean, then ratingForPercent', () => {
    const percents = [100, 100, 100, 0];
    const kpis = buildRatingKpis(percents.map((p) => real('weak', p)));
    expect(kpis.averageEffectivePercent).toBe(75);
    expect(kpis.overallQuality.band).toBe(taskService.ratingForPercent(75));
  });

  it('reproduces the live figures: 13 real + 134 synthetic rated, 5 unrated -> 0 / 81 / 6 / 60, about 62.4% -> weak', () => {
    const realRated = [
      ['weak', 56], ['fair', 70], ['weak', 0.53], ['weak', 10], ['weak', 20], ['good', 100], ['weak', 1],
      ['weak', 0], ['fair', 80], ['weak', 0], ['weak', 46], ['fair', 80], ['good', 100],
    ].map(([rating, percent]) => real(rating, percent));
    const tasks = [
      ...realRated,
      ...repeat(79, () => synthetic('good', 80, 0)),
      ...repeat(52, () => synthetic('weak', 40, 0)),
      ...repeat(3, () => synthetic('fair', 70, 0)),
      ...repeat(5, () => unrated(0)),
    ];

    expect(buildRatingKpis(tasks)).toEqual({
      bands: {
        excellent: { count: 0, percent: 0 },
        good: { count: 81, percent: 55 },
        fair: { count: 6, percent: 4 },
        weak: { count: 60, percent: 41 },
      },
      ratedCount: 147,
      unratedCount: 5,
      syntheticCount: 134,
      averageEffectivePercent: 62.4,
      overallQuality: { band: 'weak', percent: 62.4 },
    });
  });
});

// ---- Against the database: the summary follows the dashboard's filters ------------------------
// total / byStatus / byPerformance describe exactly the listed tasks (every filter). The rating
// KPIs follow every filter EXCEPT the rating one, so the four band cards keep showing the whole
// distribution while one of them is the active filter.
describe('getDashboardSummary — computed over the dashboard\'s filtered set', () => {
  beforeAll(async () => connect());
  afterEach(async () => clearDatabase());
  afterAll(async () => closeDatabase());

  const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
  let admin;
  let userA;
  let userB;

  async function seed() {
    admin = await User.create({ name: 'Admin', email: `a${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'Admin', role: 'admin' });
    userA = await User.create({ name: 'A', email: `ua${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R1', role: 'user' });
    userB = await User.create({ name: 'B', email: `ub${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R2', role: 'user' });
    const base = (code, extra) => ({
      codeNumber: code,
      title: `task ${code}`,
      assignees: [userA._id],
      responsibility: 'R1',
      deadline: day('2026-06-30'),
      createdBy: admin._id,
      createdAt: day('2026-01-10'),
      updatedAt: day('2026-01-10'),
      ...extra,
    });
    const syn = (assumedPercent) => ({ isSynthetic: true, assumedPercent, assignedAt: day('2026-10-05'), assignedBy: 'system:script' });
    await Task.create(
      [
        // userA
        base('260101', { status: 'closed', completionPercent: 95, performanceRating: 'excellent' }), // real
        base('260102', { status: 'closed', completionPercent: 0, performanceRating: 'good', syntheticRating: syn(80) }),
        base('260103', { status: 'pending', completionPercent: 20, performanceRating: 'weak', syntheticRating: syn(40), deadline: day('2026-02-15') }),
        base('260104', { status: 'ongoing', completionPercent: 10, title: 'special report' }), // unrated
        // userB
        base('260201', { assignees: [userB._id], responsibility: 'R2', status: 'closed', completionPercent: 50, performanceRating: 'weak', createdAt: day('2026-03-01') }), // real
        base('260202', { assignees: [userB._id], responsibility: 'R2', status: 'ongoing', completionPercent: 0, performanceRating: 'fair', syntheticRating: syn(70), deadline: day('2026-12-31'), createdAt: day('2026-03-05') }),
        base('260203', { assignees: [userB._id], responsibility: 'R2', status: 'closed', completionPercent: 0 }), // closed but unrated (handover)
      ],
      { timestamps: false, ordered: true }
    );
  }

  const asAdmin = () => ({ id: admin.id, role: 'admin' });
  const summaryFor = (filters, user = asAdmin()) => dashboardService.getDashboardSummary(user, filters);
  // The reference: the task list for the very same filters, reduced with the same pure function.
  async function listFor(filters, user = asAdmin()) {
    const { items } = await taskService.listTasks(user, filters, { page: 1, limit: 100, sortBy: 'codeNumber', sortOrder: 'asc' });
    return items.map((t) => t.toObject());
  }

  it('with no filter: every task (admin)', async () => {
    await seed();
    const summary = await summaryFor({});
    expect(summary.total).toBe(7);
    expect(summary.ratings).toMatchObject({ ratedCount: 5, unratedCount: 2, syntheticCount: 3 });
    // (95 + 80 + 40 + 50 + 70) / 5 = 67 -> weak
    expect(summary.ratings.overallQuality).toEqual({ band: 'weak', percent: 67 });
  });

  it.each([
    ['status', { status: 'closed' }, ['260101', '260102', '260201', '260203']],
    ['status (open)', { status: 'pending' }, ['260103']],
    ['performanceRating', { performanceRating: 'weak' }, ['260103', '260201']],
    ['performanceRating "-" (unrated)', { performanceRating: '-' }, ['260104', '260203']],
    ['ratingSource synthetic', { ratingSource: 'synthetic' }, ['260102', '260103', '260202']],
    ['ratingSource real', { ratingSource: 'real' }, ['260101', '260201']],
    ['responsibility', { responsibility: 'R2' }, ['260201', '260202', '260203']],
    ['deadline range', { deadlineFrom: new Date('2026-02-01'), deadlineTo: new Date('2026-03-01') }, ['260103']],
    ['deadline from only', { deadlineFrom: new Date('2026-12-01') }, ['260202']],
    ['entry-date range', { entryFrom: new Date('2026-03-01'), entryTo: new Date('2026-03-31') }, ['260201', '260202']],
    ['search by title', { search: 'special' }, ['260104']],
    ['search by code', { search: '26020' }, ['260201', '260202', '260203']],
    ['several filters at once', { status: 'closed', responsibility: 'R1', ratingSource: 'synthetic' }, ['260102']],
    ['a rating AND its source', { performanceRating: 'weak', ratingSource: 'real' }, ['260201']],
    ['a contradiction (unrated AND real) matches nothing', { performanceRating: '-', ratingSource: 'real' }, []],
  ])('filter by %s: total is the listed set; the rating KPIs are the same set minus the rating filter', async (_label, filters, expectedCodes) => {
    await seed();
    const withoutRatingFilter = { ...filters };
    delete withoutRatingFilter.performanceRating;

    const [summary, listed, listedIgnoringRating] = await Promise.all([summaryFor(filters), listFor(filters), listFor(withoutRatingFilter)]);

    expect(listed.map((t) => t.codeNumber)).toEqual(expectedCodes);
    expect(summary.total).toBe(expectedCodes.length);
    expect(summary.ratings).toEqual(buildRatingKpis(listedIgnoringRating));
  });

  describe('the rating filter itself does not narrow the rating KPIs', () => {
    it.each(['excellent', 'good', 'fair', 'weak', '-'])('performanceRating=%s: the band cards still show the whole distribution', async (rating) => {
      await seed();

      const [unfiltered, filtered] = await Promise.all([summaryFor({}), summaryFor({ performanceRating: rating })]);

      expect(filtered.ratings).toEqual(unfiltered.ratings);
      expect(filtered.ratings.bands).toEqual({
        excellent: { count: 1, percent: 20 },
        good: { count: 1, percent: 20 },
        fair: { count: 1, percent: 20 },
        weak: { count: 2, percent: 40 },
      });
    });

    it('...while total / byStatus / byPerformance DO follow it — they describe the listed tasks', async () => {
      await seed();

      const summary = await summaryFor({ performanceRating: 'weak' });

      expect(summary.total).toBe(2);
      expect(summary.byPerformance.weak.count).toBe(2);
      expect(summary.byPerformance.good.count).toBe(0);
      expect(summary.byStatus).toMatchObject({ pending: { count: 1, percent: 50 }, closed: { count: 1, percent: 50 } });
    });

    it('every OTHER filter still narrows the rating KPIs when a rating filter is also set', async () => {
      await seed();

      const [statusOnly, statusAndRating] = await Promise.all([
        summaryFor({ status: 'closed' }),
        summaryFor({ status: 'closed', performanceRating: 'good' }),
      ]);

      // closed tasks: real excellent 95, synthetic good 80, real weak 50 (+ one closed, unrated)
      expect(statusAndRating.ratings).toEqual(statusOnly.ratings);
      expect(statusAndRating.ratings).toMatchObject({ ratedCount: 3, unratedCount: 1, syntheticCount: 1, overallQuality: { band: 'fair', percent: 75 } });
      expect(statusAndRating.total).toBe(1); // the table lists only the one closed "good" task
    });

    it('ratingSource is NOT the rating filter: synthetic / real still narrows the rating KPIs', async () => {
      await seed();

      const [syntheticOnly, realOnly, syntheticPlusBand] = await Promise.all([
        summaryFor({ ratingSource: 'synthetic' }),
        summaryFor({ ratingSource: 'real' }),
        summaryFor({ ratingSource: 'synthetic', performanceRating: 'weak' }),
      ]);

      expect(syntheticOnly.ratings).toMatchObject({ ratedCount: 3, syntheticCount: 3, unratedCount: 0 });
      expect(realOnly.ratings).toMatchObject({ ratedCount: 2, syntheticCount: 0, unratedCount: 0 });
      expect(syntheticPlusBand.ratings).toEqual(syntheticOnly.ratings);
    });

    it('a normal user: the same rule, within their own tasks only', async () => {
      await seed();
      const asUserA = { id: userA.id, role: 'user' };

      const [mine, mineWithBand] = await Promise.all([summaryFor({}, asUserA), summaryFor({ performanceRating: 'good' }, asUserA)]);

      expect(mineWithBand.ratings).toEqual(mine.ratings);
      expect(mineWithBand.ratings.ratedCount).toBe(3); // userB's tasks never enter it
      expect(mineWithBand.total).toBe(1);
    });
  });

  it('filter by zimmedar (assigneeId): only that person\'s tasks', async () => {
    await seed();
    const filters = { assigneeId: userB.id };

    const [summary, listed] = await Promise.all([summaryFor(filters), listFor(filters)]);

    expect(listed.map((t) => t.codeNumber)).toEqual(['260201', '260202', '260203']);
    expect(summary.ratings).toEqual(buildRatingKpis(listed));
    // real weak 50 + synthetic fair 70 -> average 60 -> weak; one unrated; one synthetic
    expect(summary.ratings).toMatchObject({ ratedCount: 2, unratedCount: 1, syntheticCount: 1, overallQuality: { band: 'weak', percent: 60 } });
  });

  it('an assigneeId that is not an id at all gives an empty summary, not an error', async () => {
    await seed();
    const summary = await summaryFor({ assigneeId: 'not-an-id' });
    expect(summary.total).toBe(0);
    expect(summary.ratings).toMatchObject({ ratedCount: 0, unratedCount: 0, overallQuality: null });
  });

  it('the status and legacy performance breakdowns follow the same filter', async () => {
    await seed();
    const summary = await summaryFor({ responsibility: 'R2' });
    expect(summary.byStatus.closed.count).toBe(2);
    expect(summary.byStatus.ongoing.count).toBe(1);
    expect(summary.byPerformance.notApplicable.count).toBe(1);
  });

  describe('user scope — enforced on the server', () => {
    it('a normal user gets only the tasks they are assigned to', async () => {
      await seed();
      const summary = await summaryFor({}, { id: userA.id, role: 'user' });
      expect(summary.total).toBe(4);
      // real excellent 95, synthetic good 80, synthetic weak 40 -> average 71.6 -> fair
      expect(summary.ratings).toMatchObject({ ratedCount: 3, unratedCount: 1, syntheticCount: 2, overallQuality: { band: 'fair', percent: 71.6 } });
    });

    it('a normal user cannot widen the set by sending someone else\'s assigneeId', async () => {
      await seed();
      const asUserA = { id: userA.id, role: 'user' };
      const mine = await summaryFor({}, asUserA);
      const sneaky = await summaryFor({ assigneeId: userB.id }, asUserA);
      expect(sneaky).toEqual(mine);
    });

    it('a normal user\'s other filters apply within their own tasks only', async () => {
      await seed();
      const summary = await summaryFor({ status: 'closed' }, { id: userA.id, role: 'user' });
      expect(summary.total).toBe(2); // userB's closed tasks are not included
    });

    it('a user with no tasks gets an empty summary with no overall value', async () => {
      await seed();
      const nobody = await User.create({ name: 'N', email: `n${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R3', role: 'user' });
      const summary = await summaryFor({}, { id: nobody.id, role: 'user' });
      expect(summary.total).toBe(0);
      expect(summary.ratings.overallQuality).toBeNull();
    });
  });
});
