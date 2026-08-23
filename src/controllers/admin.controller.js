const reminderJob = require('../jobs/reminder.job');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

// POST /admin/trigger-reminders — docs/05-apis.md §10. Calls the exact same runReminderScan the
// cron schedule calls (docs/06-backend.md §8) — not a parallel/duplicate implementation.
const triggerReminders = asyncHandler(async (req, res) => {
  const { remindersSent } = await reminderJob.runReminderScan();
  sendSuccess(res, { data: { remindersSent } });
});

module.exports = { triggerReminders };
