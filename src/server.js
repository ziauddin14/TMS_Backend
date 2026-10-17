const env = require('./config/env');
const app = require('./app');
const { connectDB } = require('./config/db');
const logger = require('./utils/logger');
const appSettingService = require('./services/appSetting.service');

async function start() {
  await connectDB();
  // Activity log: the day it starts recording — written once, atomically, the first time a version
  // with the feature starts (later starts find it and leave it alone). Never allowed to stop the server.
  appSettingService.ensureActivityBaselineAtStartup();

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
