const env = require('./config/env');
const app = require('./app');
const { connectDB } = require('./config/db');
const { startReminderCron } = require('./jobs/reminder.job');
const logger = require('./utils/logger');

async function start() {
  await connectDB();

  // docs/03-backend-foundation.md §5's documented bootstrap order: env -> DB -> cron -> listen.
  // Only ever reached via server.js, which tests never import (they import app.js directly, the
  // same pattern connectDB() above already relies on) — so the cron is never registered during
  // the test suite, with no separate NODE_ENV guard needed.
  startReminderCron();

  app.listen(env.PORT, () => {
    logger.info(`Server listening on port ${env.PORT} (${env.NODE_ENV})`);
  });
}

start();
