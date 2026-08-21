const env = require('./config/env');
const app = require('./app');
const { connectDB } = require('./config/db');
const logger = require('./utils/logger');

// NOTE: the reminder cron job (jobs/reminder.job.js) is started here once it exists
// (Phase 9 — Notifications). Not implemented yet — out of scope for Phase 1.

async function start() {
  await connectDB();

  app.listen(env.PORT, () => {
    logger.info(`Server listening on port ${env.PORT} (${env.NODE_ENV})`);
  });
}

start();
