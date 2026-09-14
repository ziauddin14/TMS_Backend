const env = require('./config/env');
const app = require('./app');
const { connectDB } = require('./config/db');
const logger = require('./utils/logger');

async function start() {
  await connectDB();

  // Phase 3 — the old in-process node-cron scheduler (reminder.job.js's startReminderCron) is
  // deliberately no longer started here. The locked architecture's primary scheduler is Render
  // Cron invoking scripts/run-reminder-engine.js once daily; running both would double-scan and
  // (since automatic reminders are deduplicated per Pakistan calendar day, not per scan) silently
  // mask whichever scheduler actually failed on a given day. reminder.job.js itself is left
  // completely unmodified and importable (dormant, harmless, no longer invoked from anywhere) per
  // the locked instruction not to delete it merely for cleanup.
  app.listen(env.PORT, () => {
    logger.info(`Server listening on port ${env.PORT} (${env.NODE_ENV})`);
  });
}

start();
