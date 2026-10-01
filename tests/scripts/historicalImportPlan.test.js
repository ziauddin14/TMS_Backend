const { buildPlan, parseSourceDate, extractPercents } = require('../../scripts/historical-import/plan');

const ALPHA = '111111111111111111111111';
const BETA = '222222222222222222222222';
const ADMIN = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = new Date(Date.UTC(2026, 9, 1, 6)); // 2026-10-01, Karachi daytime

function config(overrides = {}) {
  return {
    userMap: { alpha: ALPHA, beta: BETA },
    adminUserId: ADMIN,
    responsibilityByPerson: { alpha: 'شعبہ الف', beta: 'شعبہ ب' },
    merges: {},
    statusOverrides: {},
    handoverCases: {},
    handoverDecisions: {},
    reminderDaysBefore: 2,
    now: NOW,
    ...overrides,
  };
}

function upd(speaker, text, [y, m, d], extra = {}) {
  return { speaker, text, date_year: y, date_month: m, date_day: d, ...extra };
}

function task(code, { target = '31-Dec-25', close = '', desc = 'کام کی تفصیل', updates }) {
  return {
    code,
    desc,
    target,
    close,
    code_date: `20${code.slice(0, 2)}-${code.slice(2, 4)}-${code.slice(4, 6)}`,
    updates,
  };
}

function planOne(t, overrides) {
  return buildPlan({ alpha: { title: 'x', tasks: [t] } }, config(overrides)).tasks[0];
}

describe('parseSourceDate / extractPercents', () => {
  it('parses DD-Mon-YY and D-Mon-YY as UTC midnight', () => {
    expect(parseSourceDate('31-Dec-25').toISOString()).toBe('2025-12-31T00:00:00.000Z');
    expect(parseSourceDate('5-Feb-26').toISOString()).toBe('2026-02-05T00:00:00.000Z');
  });

  it('rejects anything that is not a real calendar date', () => {
    expect(parseSourceDate('260416')).toBeNull();
    expect(parseSourceDate('31-Feb-25')).toBeNull();
    expect(parseSourceDate('')).toBeNull();
  });

  it('extracts every percentage, including decimals and Urdu digits', () => {
    expect(extractPercents('یہ کام 50 فیصد ہوا')).toEqual([50]);
    expect(extractPercents('0.53 فیصد کارکردگی')).toEqual([0.53]);
    expect(extractPercents('۴۶ فیصد اور 10 فیصد')).toEqual([46, 10]);
    expect(extractPercents('کوئی فیصد نہیں')).toEqual([]);
  });
});

describe('status — closing remark OR Close date, otherwise open', () => {
  it('an explicit closing remark in the last update closes the task (closedAt = remark date)', () => {
    const t = planOne(
      task('250110', {
        updates: [upd('zimmedar', 'کام جاری ہے', [2025, 2, 1]), upd('admin', 'یہ مدنی پھول کلوز ہوا۔', [2025, 3, 5])],
      })
    );
    expect(t.task.status).toBe('closed');
    expect(t.closureSignal).toBe('closing_remark');
    expect(t.task.closedAt.toISOString().slice(0, 10)).toBe('2025-03-05');
    expect(t.task.closedBy).toBe(ADMIN);
  });

  it('a filled Close date alone closes the task (closedAt = Close date)', () => {
    const t = planOne(task('250110', { close: '20-Mar-25', updates: [upd('zimmedar', 'کام ہو رہا ہے', [2025, 2, 1])] }));
    expect(t.task.status).toBe('closed');
    expect(t.closureSignal).toBe('close_date');
    expect(t.task.closedAt.toISOString()).toBe('2025-03-20T00:00:00.000Z');
  });

  it('an instruction to close ("کلوز کر دیجئے") is NOT a closure', () => {
    const t = planOne(task('250110', { updates: [upd('admin', 'اسے 30 جون تک کلوز کر دیجئے۔', [2025, 2, 1])] }));
    expect(t.task.status).not.toBe('closed');
  });

  it('a closure mention in an EARLIER update does not close the task', () => {
    const t = planOne(
      task('250110', {
        updates: [upd('admin', 'یہ مدنی پھول کلوز ہے۔', [2025, 2, 1]), upd('zimmedar', 'مزید کام جاری ہے', [2025, 2, 9])],
      })
    );
    expect(t.task.status).not.toBe('closed');
  });

  it('neither signal + past deadline -> pending/overdue and a TASK_OVERDUE reminder from the next scan', () => {
    const t = planOne(task('250110', { target: '31-Mar-25', updates: [upd('zimmedar', 'جاری', [2025, 2, 1])] }));
    expect(t.task.status).toBe('pending');
    expect(t.task.timeStatus.type).toBe('overdue');
    expect(t.reminderType).toBe('TASK_OVERDUE');
    expect(t.task.closedAt).toBeNull();
    expect(t.task.performanceRating).toBe('-');
  });

  it('neither signal + future deadline -> ongoing, no reminder yet', () => {
    const t = planOne(task('260410', { target: '31-Dec-26', updates: [upd('zimmedar', 'جاری', [2026, 4, 10])] }));
    expect(t.task.status).toBe('ongoing');
    expect(t.reminderType).toBeNull();
  });

  it('a configured status override wins over the Close-date rule', () => {
    const t = planOne(task('250110', { close: '20-Mar-25', updates: [upd('zimmedar', 'جاری', [2025, 2, 1])] }), {
      statusOverrides: { 250110: { status: 'open', reason: 'test' } },
    });
    expect(t.task.status).toBe('pending');
    expect(t.reviewNotes[0]).toMatch(/status override/);
  });
});

describe('completionPercent — explicit, carried forward, or 0; ambiguous figures flagged', () => {
  it('uses an explicit figure, carries it forward, and defaults to 0 before any figure', () => {
    const t = planOne(
      task('250110', {
        updates: [
          upd('zimmedar', 'شروع کیا', [2025, 1, 12]),
          upd('zimmedar', 'یہ کام 40 فیصد ہوا', [2025, 2, 1]),
          upd('admin', 'جلدی کریں', [2025, 2, 2]),
        ],
      })
    );
    expect(t.updates.map((u) => [u.update.completionPercent, u.percentSource])).toEqual([
      [0, 'default_zero'],
      [40, 'explicit'],
      [40, 'carried_forward'],
    ]);
    expect(t.task.completionPercent).toBe(40);
  });

  it('flags multiple percentages in one update and falls back to the carry-forward value', () => {
    const t = planOne(
      task('250110', {
        updates: [upd('zimmedar', '30 فیصد ہوا', [2025, 1, 12]), upd('zimmedar', 'ہدف 10 فیصد تھا، 55 فیصد ہوا', [2025, 2, 1])],
      })
    );
    expect(t.updates[1].update.completionPercent).toBe(30);
    expect(t.updates[1].dataQualityIssues).toContain('multiple_percentages_in_text');
  });

  it('flags a figure above 100 rather than clamping it', () => {
    const t = planOne(task('250110', { updates: [upd('zimmedar', '122 فیصد حاصل ہوا', [2025, 1, 12])] }));
    expect(t.updates[0].update.completionPercent).toBe(0);
    expect(t.updates[0].dataQualityIssues).toContain('percent_out_of_range');
  });
});

describe('performanceRating — existing formula only with an explicit percentage', () => {
  it('closed with an explicit % -> computed by the existing formula', () => {
    const t = planOne(
      task('250110', {
        target: '31-Dec-25',
        updates: [upd('admin', 'یہ کام 95 فیصد کارکردگی کے ساتھ کلوز ہوا۔', [2025, 3, 1])],
      })
    );
    expect(t.task.performanceRating).toBe('excellent');
    expect(t.ratingBasis).toBe('computed_from_explicit_percent');
  });

  it("closed with NO explicit % -> '-' (never assumes 100% or 0%)", () => {
    const t = planOne(task('250110', { updates: [upd('admin', 'یہ مدنی پھول کلوز ہوا۔', [2025, 3, 1])] }));
    expect(t.task.performanceRating).toBe('-');
    expect(t.ratingBasis).toBe('no_explicit_percent');
  });

  it("a handover case decided 'reassigned' forces '-'; undecided keeps the formula rating", () => {
    const src = task('250110', { updates: [upd('admin', 'یہ کام 95 فیصد کارکردگی کے ساتھ کلوز ہوا۔', [2025, 3, 1])] });
    const handoverCases = { 'alpha:250110': { bestGuess: 'reassigned', rationale: 'r' } };
    expect(planOne(src, { handoverCases, handoverDecisions: { 'alpha:250110': 'reassigned' } }).task.performanceRating).toBe('-');
    const undecided = planOne(src, { handoverCases, handoverDecisions: {} });
    expect(undecided.task.performanceRating).toBe('excellent');
    expect(undecided.handover.decision).toBeNull();
  });
});

describe('dates', () => {
  it('Task.createdAt = code_date; same-day updates keep source order', () => {
    const t = planOne(
      task('250110', { updates: [upd('zimmedar', 'الف', [2025, 1, 10]), upd('admin', 'ب', [2025, 1, 10])] })
    );
    expect(t.task.createdAt.toISOString()).toBe('2025-01-10T00:00:00.000Z');
    expect(t.updates[1].update.createdAt > t.updates[0].update.createdAt).toBe(true);
    expect(t.updates[1].update.createdAt.toISOString().slice(0, 10)).toBe('2025-01-10');
  });

  it('a creation-date placeholder on the closing remark takes the valid Close date (call #4)', () => {
    const t = planOne(
      task('250110', {
        close: '15-Apr-25',
        updates: [
          upd('zimmedar', 'کام ہو رہا ہے', [2025, 1, 10], { date_inherited: 'task_creation_fallback' }),
          upd('admin', 'یہ مدنی پھول کلوز ہوا۔', [2025, 1, 10], { date_inherited: 'forward' }),
        ],
      })
    );
    expect(t.updates[1].dateSource).toBe('close_date_substituted');
    expect(t.updates[1].update.createdAt.toISOString().slice(0, 10)).toBe('2025-04-15');
    expect(t.updates[0].dateSource).toBe('inherited_task_creation_fallback'); // non-closing: untouched
  });

  it('leaves an explicitly dated closing remark alone', () => {
    const t = planOne(
      task('250110', { close: '15-Apr-25', updates: [upd('admin', 'یہ مدنی پھول کلوز ہوا۔', [2025, 1, 10])] })
    );
    expect(t.updates[0].dateSource).toBe('explicit');
  });

  it('skips (and flags) the substitution when the Close date would precede an earlier update', () => {
    const t = planOne(
      task('250110', {
        close: '15-Jan-25',
        updates: [
          upd('zimmedar', 'جاری', [2025, 2, 1]),
          upd('admin', 'یہ مدنی پھول کلوز ہوا۔', [2025, 1, 10], { date_inherited: 'task_creation_fallback' }),
        ],
      })
    );
    expect(t.updates[1].dateSource).toBe('inherited_task_creation_fallback');
    expect(t.updates[1].dataQualityIssues).toContain('close_date_substitution_skipped_out_of_order');
  });
});

describe('data-quality flags (never silently fixed)', () => {
  it('deadline before creation is imported as written and flagged', () => {
    const t = planOne(task('250511', { target: '5-May-25', updates: [upd('zimmedar', 'جاری', [2025, 5, 11])] }));
    expect(t.task.deadline.toISOString().slice(0, 10)).toBe('2025-05-05');
    expect(t.dataQualityIssues).toContain('deadline_before_creation');
  });

  it('an unparseable Close value is treated as empty and flagged', () => {
    const t = planOne(task('260416', { close: '260416', target: '30-Apr-26', updates: [upd('zimmedar', 'جاری', [2026, 4, 16])] }));
    expect(t.dataQualityIssues).toContain('close_field_invalid');
    expect(t.task.status).not.toBe('closed');
  });
});

describe('speakers and merges', () => {
  it('maps zimmedar -> owner, admin -> admin user, other_zimmedar:<key> -> that user', () => {
    const t = planOne(
      task('250110', {
        updates: [upd('zimmedar', 'الف', [2025, 1, 10]), upd('admin', 'ب', [2025, 1, 11]), upd('other_zimmedar:beta', 'ج', [2025, 1, 12])],
      })
    );
    expect(t.updates.map((u) => u.update.updatedBy)).toEqual([ALPHA, ADMIN, BETA]);
  });

  it('refuses an unmappable speaker', () => {
    expect(() => planOne(task('250110', { updates: [upd('somebody', 'الف', [2025, 1, 10])] }))).toThrow(/Unmappable speaker/);
  });

  it('merges a configured duplicate into ONE task owned by the kept person', () => {
    const shared = [upd('zimmedar', '50 فیصد ہوا', [2026, 5, 20]), upd('admin', 'آگے بڑھائیں', [2026, 5, 21])];
    const keptCopy = [upd('other_zimmedar:alpha', '50 فیصد ہوا', [2026, 5, 20]), upd('admin', 'آگے بڑھائیں', [2026, 5, 21])];
    const plan = buildPlan(
      {
        alpha: { title: 'x', tasks: [task('260410', { target: '25-May-26', updates: shared })] },
        beta: { title: 'y', tasks: [task('260410', { target: '25-May-26', updates: keptCopy })] },
      },
      config({ merges: { 260410: { keep: 'beta', drop: ['alpha'] } } })
    );
    expect(plan.tasks).toHaveLength(1);
    expect(plan.totals).toMatchObject({ sourceTasks: 2, sourceUpdates: 4, tasks: 1, updates: 2 });
    expect(plan.tasks[0].task.assignees).toEqual([BETA]);
    expect(plan.tasks[0].updates[0].update.updatedBy).toBe(ALPHA); // handover context kept
    expect(plan.tasks[0].mergedFrom).toEqual(['alpha']);
  });

  it('refuses to merge copies whose content differs', () => {
    expect(() =>
      buildPlan(
        {
          alpha: { title: 'x', tasks: [task('260410', { updates: [upd('zimmedar', 'الف', [2026, 4, 10])] })] },
          beta: { title: 'y', tasks: [task('260410', { updates: [upd('zimmedar', 'ب', [2026, 4, 10])] })] },
        },
        config({ merges: { 260410: { keep: 'beta', drop: ['alpha'] } } })
      )
    ).toThrow(/differ/);
  });

  it('refuses an unconfigured duplicate code', () => {
    const one = task('260410', { updates: [upd('zimmedar', 'الف', [2026, 4, 10])] });
    expect(() => buildPlan({ alpha: { title: 'x', tasks: [one] }, beta: { title: 'y', tasks: [one] } }, config())).toThrow(
      /Duplicate code 260410/
    );
  });
});
