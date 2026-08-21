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
