const { formatDateShort } = require('../../src/utils/formatDate');

// Prompt — the date-order bug kept reappearing in production because report/email dates went
// through Date.prototype.toLocaleDateString()/toLocaleString(), which resolves against whatever
// ICU locale the RUNNING process happens to have — never actually fixed by fixing the frontend's
// own date column. This is the single, locale-independent formatter every backend-rendered date
// now goes through instead.
describe('formatDateShort (day-month-year, zero-padded day, 2-digit year)', () => {
  it('formats a date as "dd MMM yy"', () => {
    expect(formatDateShort('2026-09-01T00:00:00.000Z')).toBe('01 Sep 26');
    expect(formatDateShort('2026-08-25T00:00:00.000Z')).toBe('25 Aug 26');
    expect(formatDateShort(new Date('2026-01-05T00:00:00.000Z'))).toBe('05 Jan 26');
  });

  it('never falls back to a locale-dependent order regardless of what the day/month values are', () => {
    // A date whose day-of-month (2) is smaller than a 2-digit year (26) and month name length
    // varies — the exact case where a swapped field order would be hardest to notice by eye.
    expect(formatDateShort('2026-12-02T00:00:00.000Z')).toBe('02 Dec 26');
  });

  it('returns "-" for null/undefined/invalid input', () => {
    expect(formatDateShort(null)).toBe('-');
    expect(formatDateShort(undefined)).toBe('-');
    expect(formatDateShort('not-a-date')).toBe('-');
  });
});
