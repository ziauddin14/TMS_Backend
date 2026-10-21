const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const { ESTIMATE_CONDITION, NOT_ESTIMATE_CONDITION, isEstimateRating, isFinalRating, hasAdminEdit } = require('../../src/utils/syntheticRating');

// The one definition of "still an estimate" vs "final" — as a JS predicate and as MongoDB
// conditions, which must always agree.
beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

const ADMIN_ID = new mongoose.Types.ObjectId();
const AT = new Date('2026-10-05T00:00:00.000Z');
const scriptEntry = { at: AT, by: 'system:script', fromPercent: null, toPercent: 80, fromRating: '-', toRating: 'good', note: 'initial synthetic rating (closed, unrated)' };
const adminEdit = (toPercent) => ({ at: new Date('2026-10-10T00:00:00.000Z'), by: ADMIN_ID, fromPercent: 80, toPercent, fromRating: 'good', toRating: 'excellent', note: null });
const removal = { at: new Date('2026-10-11T00:00:00.000Z'), by: ADMIN_ID, fromPercent: 80, toPercent: null, fromRating: 'good', toRating: '-', note: 'synthetic rating removed' };
const replacement = { at: new Date('2026-10-12T00:00:00.000Z'), by: ADMIN_ID, fromPercent: 80, toPercent: 100, fromRating: 'good', toRating: 'excellent', note: 'synthetic rating replaced by the real rating — task completed' };
const sr = (extra) => ({ isSynthetic: true, assumedPercent: 80, assignedAt: AT, assignedBy: 'system:script', reason: 'r', history: [scriptEntry], ...extra });

// The six shapes a task's synthetic rating can have.
const SHAPES = {
  estimate: { sr: sr(), estimate: true, final: false },
  finalNew: { sr: sr({ assumedPercent: 95, finalizedAt: new Date(), finalizedBy: ADMIN_ID, history: [scriptEntry, adminEdit(95)] }), estimate: false, final: true },
  finalLegacy: { sr: sr({ assumedPercent: 95, history: [scriptEntry, adminEdit(95)] }), estimate: false, final: true },
  editedBackToAssigned: { sr: sr({ history: [scriptEntry, adminEdit(80)] }), estimate: false, final: true },
  removed: { sr: sr({ isSynthetic: false, history: [scriptEntry, removal] }), estimate: false, final: false },
  replacedByReal: { sr: sr({ isSynthetic: false, history: [scriptEntry, replacement] }), estimate: false, final: false },
  editedThenRemoved: { sr: sr({ isSynthetic: false, history: [scriptEntry, adminEdit(90), removal] }), estimate: false, final: false },
};

describe('utils/syntheticRating — the predicate', () => {
  it.each(Object.entries(SHAPES))('%s', (_name, { sr: rating, estimate, final }) => {
    expect(isEstimateRating(rating)).toBe(estimate);
    expect(isFinalRating(rating)).toBe(final);
  });

  it('no synthetic rating at all is neither', () => {
    expect(isEstimateRating(undefined)).toBe(false);
    expect(isFinalRating(undefined)).toBe(false);
    expect(isFinalRating(null)).toBe(false);
  });

  it('only an admin id counts as an editor — the script\'s string, a hex string or a removal never do', () => {
    expect(hasAdminEdit({ history: [scriptEntry] })).toBe(false);
    expect(hasAdminEdit({ history: [{ ...adminEdit(90), by: String(ADMIN_ID) }] })).toBe(false);
    expect(hasAdminEdit({ history: [removal] })).toBe(false);
    expect(hasAdminEdit({ history: [adminEdit(0)] })).toBe(true); // 0% is a number like any other
  });
});

describe('utils/syntheticRating — the MongoDB conditions agree with the predicate', () => {
  it('ESTIMATE_CONDITION / NOT_ESTIMATE_CONDITION select exactly the predicate\'s tasks', async () => {
    const admin = await User.create({ name: 'A', email: `a${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R', role: 'admin' });
    const names = Object.keys(SHAPES);
    await Task.create(
      [
        ...names.map((name, i) => ({ codeNumber: `2510${String(i).padStart(2, '0')}`, title: name, assignees: [admin._id], responsibility: 'R', deadline: AT, createdBy: admin._id, performanceRating: 'good', syntheticRating: SHAPES[name].sr })),
        { codeNumber: '251099', title: 'none', assignees: [admin._id], responsibility: 'R', deadline: AT, createdBy: admin._id },
      ],
      { ordered: true }
    );

    const titles = async (condition) => (await Task.find(condition).lean()).map((t) => t.title).sort();
    expect(await titles(ESTIMATE_CONDITION)).toEqual(names.filter((n) => SHAPES[n].estimate).sort());
    expect(await titles(NOT_ESTIMATE_CONDITION)).toEqual([...names.filter((n) => !SHAPES[n].estimate), 'none'].sort());
    // And through an aggregation, which casts nothing (the dashboard's path).
    const aggregated = await Task.aggregate([{ $match: ESTIMATE_CONDITION }, { $project: { title: 1 } }]);
    expect(aggregated.map((t) => t.title).sort()).toEqual(names.filter((n) => SHAPES[n].estimate).sort());
  });
});
