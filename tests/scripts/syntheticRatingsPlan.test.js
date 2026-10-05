const mongoose = require('mongoose');
const { buildPlan } = require('../../scripts/synthetic-ratings/plan');

// Pure planning — no database. Tasks and ledger records are plain objects shaped like lean docs.
const NOW = new Date('2026-10-05T06:00:00.000Z');
const GROUPS = [
  { key: 'closedUnrated', label: 'closed, unrated', status: 'closed', assumedPercent: 80, expectedCount: 2 },
  { key: 'pending', label: 'pending, unrated', status: 'pending', assumedPercent: 40, expectedCount: 1 },
  { key: 'ongoing', label: 'ongoing, unrated', status: 'ongoing', assumedPercent: 70, expectedCount: 1 },
];
const CONFIG = { groups: GROUPS, neverTouchCodes: ['260912'], expectedRealRated: 1, assignedBy: 'system:script', reason: 'test reason' };

function task(code, overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    codeNumber: code,
    title: `task ${code}`,
    status: 'closed',
    completionPercent: 0,
    performanceRating: '-',
    timeStatus: { type: 'early', days: 1 },
    ...overrides,
  };
}
const imported = (t, flags = {}) => ({ targetId: t._id, taskCode: t.codeNumber, personKey: 'alpha', flags });
const rated = (t, group) => ({ targetId: t._id, taskCode: t.codeNumber, next: { group } });

function scenario() {
  const closedA = task('250101');
  const closedB = task('250102', { timeStatus: { type: 'late', days: 30 } });
  const pending = task('250103', { status: 'pending', completionPercent: 25, timeStatus: { type: 'overdue', days: 9 } });
  const ongoing = task('250104', { status: 'ongoing' });
  const realRated = task('250105', { performanceRating: 'weak', completionPercent: 10 });
  const testTask = task('260912', { status: 'pending', completionPercent: 20 });
  const tasks = [closedA, closedB, pending, ongoing, realRated, testTask];
  // The live test task was never part of the import, so it has no import record.
  const importRecords = [closedA, closedB, pending, ongoing, realRated].map((t) => imported(t));
  return { closedA, closedB, pending, ongoing, realRated, testTask, tasks, importRecords };
}
const plan = (s, extra = {}) => buildPlan({ tasks: s.tasks, importRecords: s.importRecords, ratingRecords: [], config: CONFIG, now: NOW, ...extra });

describe('synthetic ratings — buildPlan', () => {
  it('puts each unrated imported task in its status group with that group\'s assumed percent and rating', () => {
    const p = plan(scenario());

    expect(p.ok).toBe(true);
    expect(p.items.map((i) => [i.code, i.group, i.assumedPercent, i.newRating])).toEqual([
      ['250101', 'closedUnrated', 80, 'good'],
      ['250102', 'closedUnrated', 80, 'good'],
      ['250103', 'pending', 40, 'weak'],
      ['250104', 'ongoing', 70, 'fair'],
    ]);
    expect(p.totals).toEqual({ tasks: 6, toAssign: 4, alreadySynthetic: 0, replacedByReal: 0 });
  });

  it('uses the plain thresholds with NO late downgrade — a late closed task still gets "good" for 80%', () => {
    const p = plan(scenario());
    const late = p.items.find((i) => i.code === '250102');
    expect(late.newRating).toBe('good'); // a real rating would have been downgraded to "fair"
  });

  it('never plans a task on the never-touch list, even though it matches a group', () => {
    const p = plan(scenario());
    expect(p.items.map((i) => i.code)).not.toContain('260912');
    expect(p.neverTouched).toEqual([expect.objectContaining({ code: '260912', status: 'pending', performanceRating: '-' })]);
  });

  it('never plans a task that already has a real rating', () => {
    const p = plan(scenario());
    expect(p.items.map((i) => i.code)).not.toContain('250105');
    expect(p.realRated).toEqual([expect.objectContaining({ code: '250105', performanceRating: 'weak' })]);
  });

  it('treats a missing performanceRating field the same as "-"', () => {
    const s = scenario();
    delete s.closedA.performanceRating;
    const p = plan(s);
    expect(p.items.find((i) => i.code === '250101')).toMatchObject({ performanceRating: null, newRating: 'good' });
  });

  it('does not make an unrated task eligible unless the historical import created it', () => {
    const s = scenario();
    const liveTask = task('261001', { status: 'ongoing' });
    s.tasks.push(liveTask);
    const p = plan(s);

    expect(p.items.map((i) => i.code)).not.toContain('261001');
    expect(p.notEligible).toEqual([expect.objectContaining({ code: '261001', why: 'not created by the historical import' })]);
    expect(p.ok).toBe(true); // it does not disturb the group counts either
  });

  it('reports an unrated imported task whose status is not one of the groups, without planning it', () => {
    const s = scenario();
    const complete = task('250106', { status: 'complete' });
    s.tasks.push(complete);
    s.importRecords.push(imported(complete));
    const p = plan(s);
    expect(p.items.map((i) => i.code)).not.toContain('250106');
    expect(p.notEligible).toEqual([expect.objectContaining({ code: '250106' })]);
  });

  it('fails its check — and says what it found — when a group does not match its expected count exactly', () => {
    const s = scenario();
    const extra = task('250107', { status: 'pending' });
    s.tasks.push(extra);
    s.importRecords.push(imported(extra));
    const p = plan(s);

    expect(p.ok).toBe(false);
    expect(p.checks.find((c) => c.label.startsWith('pending'))).toMatchObject({ ok: false, detail: 'found 2 (2 to assign, 0 already synthetic)' });
  });

  it('fails its check when the number of really-rated tasks is not the expected one', () => {
    const s = scenario();
    s.realRated.performanceRating = '-'; // now a third closed-unrated task, and no real rating left
    const p = plan(s);
    expect(p.ok).toBe(false);
    expect(p.checks.find((c) => c.label.startsWith('really-rated'))).toMatchObject({ ok: false, detail: 'found 0' });
  });

  it('is idempotent: an already-synthetic task counts towards its group and is not planned again', () => {
    const s = scenario();
    s.closedA.performanceRating = 'good';
    s.closedA.syntheticRating = { isSynthetic: true, assumedPercent: 80 };
    const p = plan(s, { ratingRecords: [rated(s.closedA, 'closedUnrated')] });

    expect(p.ok).toBe(true);
    expect(p.items.map((i) => i.code)).toEqual(['250102', '250103', '250104']);
    expect(p.groups.closedUnrated.alreadySynthetic.map((t) => t.code)).toEqual(['250101']);
    expect(p.realRated.map((t) => t.code)).toEqual(['250105']); // a synthetic rating is not a real one
  });

  it('counts an already-synthetic task in the group it was assigned in, even if its status has changed since', () => {
    const s = scenario();
    s.ongoing.status = 'pending'; // went overdue after being rated as "ongoing"
    s.ongoing.performanceRating = 'fair';
    s.ongoing.syntheticRating = { isSynthetic: true, assumedPercent: 70 };
    const p = plan(s, { ratingRecords: [rated(s.ongoing, 'ongoing')] });

    expect(p.ok).toBe(true);
    expect(p.groups.ongoing.alreadySynthetic.map((t) => t.code)).toEqual(['250104']);
    expect(p.groups.pending.toAssign.map((t) => t.code)).toEqual(['250103']);
  });

  it('recognises a synthetic rating the app has since replaced with a real one: counted in its group, never planned again, not one of the import\'s really-rated tasks', () => {
    const s = scenario();
    // Given "weak" (assumed 40%) while pending; later really closed at 95% — the app's rule made the
    // rating real and switched the marker off, keeping the subdocument as a record.
    s.pending.status = 'closed';
    s.pending.completionPercent = 95;
    s.pending.performanceRating = 'excellent';
    s.pending.syntheticRating = { isSynthetic: false, assumedPercent: 40 };
    const p = plan(s, { ratingRecords: [rated(s.pending, 'pending')] });

    expect(p.ok).toBe(true);
    expect(p.anomalies).toEqual([]);
    expect(p.items.map((i) => i.code)).not.toContain('250103');
    expect(p.groups.pending.replacedByReal.map((t) => t.code)).toEqual(['250103']);
    expect(p.checks.find((c) => c.label.startsWith('pending'))).toMatchObject({ ok: true, detail: 'found 1 (0 to assign, 0 already synthetic, 1 since replaced by a real rating)' });
    expect(p.realRated.map((t) => t.code)).toEqual(['250105']);
    expect(p.totals).toMatchObject({ toAssign: 3, replacedByReal: 1 });
  });

  it('flags a task that is marked synthetic but has no ledger record, and a ledger record whose task is not synthetic', () => {
    const s = scenario();
    s.closedA.syntheticRating = { isSynthetic: true, assumedPercent: 80 };
    const p = plan(s, { ratingRecords: [rated(s.closedB, 'closedUnrated')] });

    expect(p.ok).toBe(false);
    expect(p.anomalies).toEqual([
      '250101: carries a synthetic rating but has no matching ledger record',
      '250102: has an active synthetic-rating ledger record but the task carries no synthetic rating',
    ]);
  });

  it('builds exactly the subdocument that will be written, with one history entry', () => {
    const p = plan(scenario());
    expect(p.items.find((i) => i.code === '250103').syntheticRating).toEqual({
      isSynthetic: true,
      assumedPercent: 40,
      assignedAt: NOW,
      assignedBy: 'system:script',
      reason: 'test reason',
      history: [{ at: NOW, by: 'system:script', fromPercent: null, toPercent: 40, fromRating: '-', toRating: 'weak', note: 'initial synthetic rating (pending, unrated)' }],
    });
  });

  it('carries the import\'s person key, and fails its checks if a task the import review left unrated as a handover is in the plan', () => {
    const s = scenario();
    s.importRecords[0] = imported(s.closedA, { ratingBasis: 'no_explicit_percent', handover: { decision: 'reassigned' } });
    s.importRecords[1] = imported(s.closedB, { ratingBasis: 'handover_reassigned' });
    const p = plan(s);

    expect(p.items[0]).toMatchObject({ personKey: 'alpha', importFlags: { ratingBasis: 'no_explicit_percent', handoverDecision: 'reassigned' } });
    expect(p.reviewNotes.map((n) => n.code)).toEqual(['250101', '250102']);
    expect(p.ok).toBe(false);
    expect(p.checks.find((c) => c.label.startsWith('no task the import review'))).toMatchObject({ ok: false, detail: 'in the plan: 250101, 250102' });
  });
});

describe('synthetic ratings — buildPlan, excluded tasks (stay unrated)', () => {
  // closedA is a handover the review left unrated: excluded, so the closed group is one smaller.
  const withExclusion = (s, extraConfig = {}) =>
    buildPlan({
      tasks: s.tasks,
      importRecords: s.importRecords,
      ratingRecords: [],
      now: NOW,
      config: {
        ...CONFIG,
        groups: GROUPS.map((g) => (g.key === 'closedUnrated' ? { ...g, expectedCount: 1 } : g)),
        excludedCodes: { '250101': 'closed as a handover' },
        ...extraConfig,
      },
    });

  it('never plans an excluded task, lists it with its reason, and passes while it is still unrated', () => {
    const s = scenario();
    s.importRecords[0] = imported(s.closedA, { handover: { decision: 'reassigned' } });
    const p = withExclusion(s);

    expect(p.ok).toBe(true);
    expect(p.items.map((i) => i.code)).toEqual(['250102', '250103', '250104']);
    expect(p.excluded).toEqual([expect.objectContaining({ code: '250101', performanceRating: '-', why: 'closed as a handover', staysUnrated: true })]);
    expect(p.checks.find((c) => c.label === 'excluded task 250101 stays unrated')).toMatchObject({ ok: true });
    // The handover task is not in the plan, so that check passes too.
    expect(p.reviewNotes).toEqual([]);
    expect(p.totals.toAssign).toBe(3);
  });

  it('does not count an excluded task as a really-rated one or in any group', () => {
    const p = withExclusion(scenario());
    expect(p.realRated.map((t) => t.code)).toEqual(['250105']);
    expect(p.groups.closedUnrated.toAssign.map((t) => t.code)).toEqual(['250102']);
  });

  it('fails its check if an excluded task is missing from the database', () => {
    const s = scenario();
    s.tasks = s.tasks.filter((t) => t.codeNumber !== '250101');
    const p = withExclusion(s);
    expect(p.ok).toBe(false);
    expect(p.checks.find((c) => c.label === 'excluded task 250101 stays unrated')).toMatchObject({ ok: false, detail: 'NOT FOUND in the database' });
  });

  it('fails its check if an excluded task is no longer unrated', () => {
    const s = scenario();
    s.closedA.performanceRating = 'good';
    s.closedA.syntheticRating = { isSynthetic: true, assumedPercent: 80 };
    const p = withExclusion(s);
    expect(p.ok).toBe(false);
    expect(p.checks.find((c) => c.label === 'excluded task 250101 stays unrated')).toMatchObject({ ok: false, detail: 'present but no longer unrated (rating good)' });
  });

  it('with no exclusion list configured, behaves exactly as before', () => {
    const p = plan(scenario());
    expect(p.excluded).toEqual([]);
    expect(p.checks.some((c) => c.label.startsWith('excluded task'))).toBe(false);
  });
});
