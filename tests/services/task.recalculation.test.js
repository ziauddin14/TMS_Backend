const { computeTimeStatus, computePerformanceRating } = require('../../src/services/task.service');

function daysFromNow(days) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}

describe('computeTimeStatus (docs/12-testing.md §3, docs/02-db-design.md §7)', () => {
  it('deadline 5 days away -> remaining, days:5', () => {
    const task = { status: 'ongoing', deadline: daysFromNow(5) };
    expect(computeTimeStatus(task, new Date())).toEqual({ type: 'remaining', days: 5 });
  });

  it('deadline yesterday -> overdue, days:1', () => {
    const task = { status: 'ongoing', deadline: daysFromNow(-1) };
    expect(computeTimeStatus(task, new Date())).toEqual({ type: 'overdue', days: 1 });
  });

  it('deadline exactly today -> boundary case: remaining, days:0 (not overdue)', () => {
    const now = new Date();
    now.setHours(23, 59, 0, 0);
    const deadline = new Date(now);
    deadline.setHours(0, 0, 0, 0);
    const task = { status: 'ongoing', deadline };
    expect(computeTimeStatus(task, now)).toEqual({ type: 'remaining', days: 0 });
  });

  it('pending status is treated the same as ongoing', () => {
    const task = { status: 'pending', deadline: daysFromNow(3) };
    expect(computeTimeStatus(task, new Date())).toEqual({ type: 'remaining', days: 3 });
  });

  it('completed 2 days before deadline -> early, days:2', () => {
    const task = {
      status: 'complete',
      deadline: daysFromNow(0),
      lastUpdateAt: daysFromNow(-2),
      closedAt: null,
      updatedAt: new Date(),
    };
    expect(computeTimeStatus(task)).toEqual({ type: 'early', days: 2 });
  });

  it('completed 3 days after deadline -> late, days:3', () => {
    const task = {
      status: 'complete',
      deadline: daysFromNow(-3),
      lastUpdateAt: daysFromNow(0),
      closedAt: null,
      updatedAt: new Date(),
    };
    expect(computeTimeStatus(task)).toEqual({ type: 'late', days: 3 });
  });

  it('a task closed with zero prior updates falls back to closedAt (no crash on null lastUpdateAt)', () => {
    const task = {
      status: 'closed',
      deadline: daysFromNow(-1),
      lastUpdateAt: null,
      closedAt: daysFromNow(0),
      updatedAt: new Date(),
    };
    expect(computeTimeStatus(task)).toEqual({ type: 'late', days: 1 });
  });

  it('falls back further to updatedAt if both lastUpdateAt and closedAt are null', () => {
    const task = {
      status: 'complete',
      deadline: daysFromNow(0),
      lastUpdateAt: null,
      closedAt: null,
      updatedAt: daysFromNow(2),
    };
    expect(computeTimeStatus(task)).toEqual({ type: 'late', days: 2 });
  });
});

// Phase 3 §5/§6/§26 — startOfDay()'s business-day boundary must be Asia/Karachi, not whatever
// timezone the host process happens to run in. All instants below are built with Date.UTC(...)
// (never a Date's local getters/setters), so these tests exercise the real boundary regardless of
// this machine's own local timezone. Asia/Karachi is a fixed UTC+5 with no DST (since 2002), so
// Karachi midnight for a given Pakistan calendar date always falls at 19:00 UTC the previous day.
describe('computeTimeStatus / startOfDay — Karachi business-day boundary (Phase 3)', () => {
  const originalTZ = process.env.TZ;

  afterEach(() => {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  });

  it('flips from "due tomorrow" (1 day) to "due today" (0 days) exactly at Karachi midnight, not UTC midnight', () => {
    const deadline = new Date(Date.UTC(2026, 8, 16, 10, 0, 0)); // 2026-09-16 15:00 PKT
    const oneMinuteBeforeKarachiMidnight = new Date(Date.UTC(2026, 8, 15, 18, 59, 0)); // still 2026-09-15 in Karachi
    const oneMinuteAfterKarachiMidnight = new Date(Date.UTC(2026, 8, 15, 19, 1, 0)); // already 2026-09-16 in Karachi

    expect(computeTimeStatus({ status: 'ongoing', deadline }, oneMinuteBeforeKarachiMidnight)).toEqual({
      type: 'remaining',
      days: 1,
    });
    expect(computeTimeStatus({ status: 'ongoing', deadline }, oneMinuteAfterKarachiMidnight)).toEqual({
      type: 'remaining',
      days: 0,
    });
  });

  it('a task becomes overdue at Karachi midnight, two minutes apart in absolute time straddling the boundary', () => {
    const deadline = new Date(Date.UTC(2026, 8, 15, 8, 0, 0)); // 2026-09-15 13:00 PKT
    const stillKarachiSep15 = new Date(Date.UTC(2026, 8, 15, 18, 0, 0));
    const alreadyKarachiSep16 = new Date(Date.UTC(2026, 8, 15, 19, 30, 0));

    expect(computeTimeStatus({ status: 'ongoing', deadline }, stillKarachiSep15)).toEqual({
      type: 'remaining',
      days: 0,
    });
    expect(computeTimeStatus({ status: 'ongoing', deadline }, alreadyKarachiSep16)).toEqual({
      type: 'overdue',
      days: 1,
    });
  });

  // §26 — must remain correct even when the Node process's own timezone is UTC (Render's likely
  // default), not just on a dev machine that happens to already be Asia/Karachi. startOfDay()
  // reads Asia/Karachi via Intl.DateTimeFormat's explicit `timeZone` option, never
  // process.env.TZ or a Date's local getters — so forcing the process to UTC must change nothing.
  it('gives an identical result whether the process timezone is forced to UTC or left as-is', () => {
    const deadline = new Date(Date.UTC(2026, 8, 16, 10, 0, 0));
    const now = new Date(Date.UTC(2026, 8, 15, 19, 1, 0));

    process.env.TZ = 'UTC';
    const underUTC = computeTimeStatus({ status: 'ongoing', deadline }, now);

    process.env.TZ = originalTZ;
    const underOriginalTZ = computeTimeStatus({ status: 'ongoing', deadline }, now);

    expect(underUTC).toEqual({ type: 'remaining', days: 0 });
    expect(underUTC).toEqual(underOriginalTZ);
  });
});

describe('computePerformanceRating(completionPercent, timeStatus, status) (docs/12-testing.md §3)', () => {
  it('95% on time -> excellent', () => {
    expect(computePerformanceRating(95, { type: 'early', days: 1 }, 'complete')).toBe('excellent');
  });

  it('95% but late -> downgraded to good', () => {
    expect(computePerformanceRating(95, { type: 'late', days: 1 }, 'complete')).toBe('good');
  });

  it('70% exactly -> fair (boundary)', () => {
    expect(computePerformanceRating(70, { type: 'early', days: 0 }, 'complete')).toBe('fair');
  });

  it('69% -> weak', () => {
    expect(computePerformanceRating(69, { type: 'early', days: 0 }, 'complete')).toBe('weak');
  });

  it('weak + late -> stays weak (floor, does not go negative)', () => {
    expect(computePerformanceRating(50, { type: 'late', days: 5 }, 'complete')).toBe('weak');
  });

  it('task still ongoing/pending -> always "-" regardless of current %', () => {
    expect(computePerformanceRating(95, { type: 'remaining', days: 5 }, 'ongoing')).toBe('-');
    expect(computePerformanceRating(0, { type: 'overdue', days: 5 }, 'pending')).toBe('-');
  });

  it('closed status is graded exactly like complete', () => {
    expect(computePerformanceRating(92, { type: 'early', days: 1 }, 'closed')).toBe('excellent');
  });
});
