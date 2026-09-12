const { formatDateShort } = require('../../src/utils/formatDate');

// Prompt — the date-order bug kept reappearing in production because report/email dates went
// through Date.prototype.toLocaleDateString()/toLocaleString(), which resolves against whatever
// ICU locale the RUNNING process happens to have — never actually fixed by fixing the frontend's
// own date column. This is the single, locale-independent formatter every backend-rendered date
// now goes through instead.
describe('formatDateShort (DD-MM-YY, zero-padded day/month, 2-digit year)', () => {
  it('formats a date as "DD-MM-YY"', () => {
    expect(formatDateShort('2026-09-01T00:00:00.000Z')).toBe('01-09-26');
    expect(formatDateShort('2026-08-25T00:00:00.000Z')).toBe('25-08-26');
    expect(formatDateShort(new Date('2026-01-05T00:00:00.000Z'))).toBe('05-01-26');
  });

  it('never falls back to a locale-dependent order regardless of what the day/month values are', () => {
    // A date whose day-of-month (2) is smaller than the month (12) and the 2-digit year (26) —
    // the exact case where a swapped field order would be hardest to notice by eye.
    expect(formatDateShort('2026-12-02T00:00:00.000Z')).toBe('02-12-26');
  });

  it('returns "-" for null/undefined/invalid input', () => {
    expect(formatDateShort(null)).toBe('-');
    expect(formatDateShort(undefined)).toBe('-');
    expect(formatDateShort('not-a-date')).toBe('-');
  });
});
