// Single source of truth for every backend-rendered date (report exports, reminder emails) —
// FINAL DATE FORMAT: zero-padded numeric DD-MM-YY, e.g. "01-09-26". Mirrors the frontend's own
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
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear()).slice(-2);
  return `${day}-${month}-${year}`;
}

// The same DD-MM-YY, but always the calendar date in Pakistan (Asia/Karachi), whatever timezone
// the server runs in — for text a person reads as a date of their own day (the task-receipt
// notices). Intl with an explicit timeZone does not depend on the host's TZ.
const karachiDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function formatDateShortKarachi(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const parts = {};
  karachiDateFormatter.formatToParts(d).forEach((part) => {
    parts[part.type] = part.value;
  });
  return `${parts.day}-${parts.month}-${parts.year.slice(-2)}`;
}

module.exports = { formatDateShort, formatDateShortKarachi };
