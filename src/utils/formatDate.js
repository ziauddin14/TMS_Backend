const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Single source of truth for every backend-rendered date (report exports, reminder emails) —
// zero-padded day, 3-letter month, 2-digit year, e.g. "01 Sep 26". Mirrors the frontend's own
// formatDateShortYear (frontend/src/utils/formatDate.js) so a date reads identically everywhere
// in the app, regardless of which side rendered it. Deliberately never delegates to
// Date.prototype.toLocaleDateString()/toLocaleString() — those resolve against the RUNNING
// process's default ICU locale, which is why report/email dates kept reappearing in the wrong
// order in production even after the frontend's own date column was fixed: the frontend bug and
// this one were never the same bug.
function formatDateShort(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const day = String(d.getDate()).padStart(2, '0');
  const month = MONTH_NAMES[d.getMonth()];
  const year = String(d.getFullYear()).slice(-2);
  return `${day} ${month} ${year}`;
}

module.exports = { formatDateShort, MONTH_NAMES };
