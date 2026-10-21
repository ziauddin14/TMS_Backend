const mongoose = require('mongoose');
const { classify } = require('../../scripts/finalized-estimates/classify');

// The READ-ONLY review behind scripts/finalized-estimates-dry-run.js. Pure — no database here.
const ADMIN = new mongoose.Types.ObjectId();
const OTHER_ADMIN = new mongoose.Types.ObjectId();
const AT = new Date('2026-10-05T06:00:00.000Z');
const EDIT_AT = new Date('2026-10-12T10:00:00.000Z');

const scriptEntry = (toPercent, toRating) => ({ at: AT, by: 'system:script', fromPercent: null, toPercent, fromRating: '-', toRating, note: 'initial synthetic rating (closed, unrated)' });
const edit = (fromPercent, toPercent, by = ADMIN, at = EDIT_AT) => ({ at, by, fromPercent, toPercent, fromRating: 'good', toRating: 'excellent', note: null });
const removal = { at: new Date('2026-10-14T00:00:00.000Z'), by: ADMIN, fromPercent: 95, toPercent: null, fromRating: 'excellent', toRating: '-', note: 'synthetic rating removed' };
const replacement = { at: new Date('2026-10-15T00:00:00.000Z'), by: ADMIN, fromPercent: 40, toPercent: 100, fromRating: 'weak', toRating: 'excellent', note: 'synthetic rating replaced by the real rating — task completed' };

let counter = 0;
function task(code, { status = 'closed', completionPercent = 0, performanceRating = 'good', ...sr }) {
  counter += 1;
  return {
    _id: new mongoose.Types.ObjectId(),
    codeNumber: code,
    status,
    completionPercent,
    performanceRating,
    syntheticRating: { isSynthetic: true, assumedPercent: 80, assignedAt: AT, assignedBy: 'system:script', history: [scriptEntry(80, 'good')], ...sr },
    n: counter,
  };
}
const assigned = (t, assumedPercent = 80, performanceRating = 'good') => ({ targetId: t._id, taskCode: t.codeNumber, next: { assumedPercent, performanceRating } });
const codes = (list) => list.map((row) => row.code);

describe('finalized-estimates classifier', () => {
  it('an untouched estimate is in no list — it simply stays an estimate', () => {
    const t = task('250201', {});
    const { lists, totals } = classify({ tasks: [t], assignRecords: [assigned(t)] });
    Object.values(lists).forEach((list) => expect(list).toEqual([]));
    expect(totals).toMatchObject({ tasksWithSyntheticRating: 1, stillEstimates: 1, becomesFinal: 0, estimatedRatingsShownBefore: 1, estimatedRatingsShownAfter: 1 });
  });

  it('list 1 — becomes final: an admin edit in the history (before this change), finalizedAt (after it), an edit back to the assigned percent', () => {
    const legacy = task('250202', { performanceRating: 'excellent', assumedPercent: 95, history: [scriptEntry(80, 'good'), edit(80, 95)] });
    const marked = task('250203', { performanceRating: 'excellent', assumedPercent: 92, finalizedAt: EDIT_AT, finalizedBy: ADMIN, history: [scriptEntry(80, 'good'), edit(80, 92)] });
    const back = task('250204', { history: [scriptEntry(80, 'good'), edit(80, 90), edit(90, 80, OTHER_ADMIN, new Date('2026-10-13T00:00:00.000Z'))] });

    const { lists, totals } = classify({ tasks: [legacy, marked, back], assignRecords: [assigned(legacy), assigned(marked), assigned(back)] });

    expect(codes(lists.becomesFinal)).toEqual(['250202', '250203', '250204']);
    expect(lists.becomesFinal[0]).toMatchObject({ basis: 'history (admin edit)', adminEdits: 1, lastEdit: '80% → 95%', lastEditorId: String(ADMIN), assumedPercent: 95, performanceRating: 'excellent' });
    expect(lists.becomesFinal[1]).toMatchObject({ basis: 'finalizedAt' });
    expect(lists.becomesFinal[2]).toMatchObject({ adminEdits: 2, lastEdit: '90% → 80%', lastEditorId: String(OTHER_ADMIN) });
    expect(lists.ambiguous).toEqual([]); // differing from the assignment is expected once an admin edited it
    expect(totals).toMatchObject({ stillEstimates: 0, becomesFinal: 3, estimatedRatingsShownBefore: 3, estimatedRatingsShownAfter: 0 });
  });

  it('list 2 — edited, then removed (only when there was an edit before the removal)', () => {
    const editedRemoved = task('250205', { isSynthetic: false, performanceRating: '-', history: [scriptEntry(80, 'good'), edit(80, 95), removal] });
    const removedOnly = task('250206', { isSynthetic: false, performanceRating: '-', history: [scriptEntry(80, 'good'), removal] });
    const { lists } = classify({ tasks: [editedRemoved, removedOnly] });
    expect(codes(lists.editedThenRemoved)).toEqual(['250205']);
    expect(lists.editedThenRemoved[0]).toMatchObject({ adminEdits: 1, removedAt: removal.at.toISOString() });
    expect(lists.ambiguous).toEqual([]);
  });

  it('list 3 — edited, then replaced by a real rating (the replacement entry itself is not an edit)', () => {
    const editedReplaced = task('250207', { status: 'complete', completionPercent: 100, isSynthetic: false, performanceRating: 'excellent', history: [scriptEntry(40, 'weak'), edit(40, 60), replacement] });
    const replacedOnly = task('250208', { status: 'complete', completionPercent: 100, isSynthetic: false, performanceRating: 'excellent', history: [scriptEntry(40, 'weak'), replacement] });
    const { lists } = classify({ tasks: [editedReplaced, replacedOnly] });
    expect(codes(lists.editedThenReplacedByReal)).toEqual(['250207']);
    expect(lists.editedThenReplacedByReal[0]).toMatchObject({ adminEdits: 1, replacedAt: replacement.at.toISOString() });
    expect(codes(lists.editedThenRemoved)).toEqual([]);
  });

  it('list 4 — ambiguous: changed outside the app, no assignment record, an unexpected author, switched off with no entry, inconsistent', () => {
    const changedOutside = task('250209', { assumedPercent: 90, performanceRating: 'excellent' }); // script history only, ledger says 80
    const noLedger = task('250210', {});
    const hexAuthor = task('250211', { history: [scriptEntry(80, 'good'), { ...edit(80, 95), by: String(ADMIN) }] });
    const offNoEntry = task('250212', { isSynthetic: false, performanceRating: '-' });
    const inconsistent = task('250213', { history: [scriptEntry(80, 'good'), removal] });

    const { lists } = classify({
      tasks: [changedOutside, noLedger, hexAuthor, offNoEntry, inconsistent],
      assignRecords: [assigned(changedOutside), assigned(hexAuthor), assigned(offNoEntry), assigned(inconsistent)],
    });

    expect(codes(lists.ambiguous)).toEqual(['250209', '250210', '250211', '250212', '250213']);
    const why = Object.fromEntries(lists.ambiguous.map((row) => [row.code, row.reasons.join(' / ')]));
    expect(why['250209']).toMatch(/changed outside the app/);
    expect(why['250210']).toMatch(/no assignment ledger record/);
    expect(why['250211']).toMatch(/unexpected author/);
    expect(why['250212']).toMatch(/switched off/);
    expect(why['250213']).toMatch(/records a removal or a real-rating replacement/);
    expect(codes(lists.becomesFinal)).toEqual([]); // a hex STRING author is not an admin edit
  });

  it('list 5 — an activity-log edit with no matching admin edit in the history', () => {
    const edited = task('250214', { performanceRating: 'excellent', assumedPercent: 95, history: [scriptEntry(80, 'good'), edit(80, 95)] });
    const notEdited = task('250215', {});
    const events = [
      { user: ADMIN, at: new Date(EDIT_AT.getTime() + 2000), taskId: edited._id, metadata: { taskCode: '250214', fromPercent: 80, toPercent: 95 } }, // matches
      { user: ADMIN, at: EDIT_AT, taskId: notEdited._id, metadata: { taskCode: '250215', fromPercent: 80, toPercent: 70 } }, // no entry
      { user: ADMIN, at: new Date(EDIT_AT.getTime() + 3 * 60 * 60 * 1000), taskId: edited._id, metadata: { taskCode: '250214', fromPercent: 80, toPercent: 95 } }, // too far apart
      { user: ADMIN, at: EDIT_AT, taskId: new mongoose.Types.ObjectId(), metadata: { taskCode: '259999', fromPercent: 10, toPercent: 20 } }, // unknown task
    ];

    const { lists } = classify({ tasks: [edited, notEdited], assignRecords: [assigned(edited), assigned(notEdited)], activityEvents: events });

    expect(lists.activityWithoutHistory.map((row) => `${row.code} ${row.change}`)).toEqual(['250214 80% → 95%', '250215 80% → 70%', '259999 10% → 20%']);
    expect(lists.activityWithoutHistory.find((row) => row.code === '259999').why).toMatch(/no longer carries a synthetic rating/);
  });

  it('ignores tasks without a synthetic rating and never mutates its input', () => {
    const plain = { _id: new mongoose.Types.ObjectId(), codeNumber: '250216', status: 'closed', completionPercent: 50, performanceRating: 'weak' };
    const t = task('250217', { history: [scriptEntry(80, 'good'), edit(80, 95)] });
    const input = { tasks: [plain, t], assignRecords: [assigned(t)], activityEvents: [] };
    const frozen = JSON.stringify(input);
    const { totals } = classify(input);
    expect(totals.tasksWithSyntheticRating).toBe(1);
    expect(JSON.stringify(input)).toBe(frozen);
  });
});
