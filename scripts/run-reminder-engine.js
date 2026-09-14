// Standalone entrypoint for the Phase 3 production scheduler (locked blueprint §21):
//   Render Cron Job -> this script -> reminder-engine.service.js -> notification.service.js
// Run once daily against the Pakistan (Asia/Karachi) business calendar: `node scripts/run-reminder-engine.js`.
// Deliberately NOT the long-running web process — no app.listen() here — so it runs as a
// short-lived Render Cron Job process, separate from (and never duplicating) the web dyno's own
// scheduler. The admin's manual "یاد دہانیاں بھیجیں" trigger calls the exact same
// runReminderEngine() through POST /admin/trigger-reminders; this script is only a second caller
// of that one engine, never a second implementation of it.
//
// Deployment note: whether a Render Cron Job is actually configured to run this script requires
// verification in the Render dashboard — this file only provides the callable entrypoint the
// locked blueprint requires. It does not itself constitute a deployed schedule.
const mongoose = require('mongoose');
require('../src/config/env');
const { connectDB } = require('../src/config/db');
const { runReminderEngine } = require('../src/services/reminder-engine.service');
const logger = require('../src/utils/logger');

async function main() {
  await connectDB();
  try {
    const summary = await runReminderEngine();
    logger.info('Reminder engine run complete:', summary);
  } finally {
    await mongoose.connection.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('Reminder engine run failed:', err);
    process.exit(1);
  });
