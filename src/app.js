const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');

const env = require('./config/env');
const notFoundHandler = require('./middleware/notFound.middleware');
const errorHandler = require('./middleware/error.middleware');

const app = express();

const allowedOrigins = [env.FRONTEND_URL];
if (env.NODE_ENV !== 'production') {
  allowedOrigins.push('https://tms-donationbox.vercel.app');
}

app.use(helmet());
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);
app.use(express.json());
app.use(compression());
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev', { skip: () => env.NODE_ENV === 'test' }));

// Health check — unauthenticated, used by Render's health check (docs/03-backend-foundation.md §11).
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/v1/auth', require('./routes/auth.routes'));
app.use('/api/v1/users', require('./routes/users.routes'));
app.use('/api/v1/lookup-lists', require('./routes/lookupList.routes'));
app.use('/api/v1/tasks', require('./routes/tasks.routes'));
// Separate mount (not nested inside tasks.routes.js, which Phase 6 leaves untouched) — mergeParams
// on the sub-router gives it req.params.id from this path segment.
app.use('/api/v1/tasks/:id/updates', require('./routes/taskUpdate.routes'));
app.use('/api/v1/uploads', require('./routes/uploads.routes'));
app.use('/api/v1/dashboard', require('./routes/dashboard.routes'));
app.use('/api/v1/reports', require('./routes/reports.routes'));
app.use('/api/v1/admin', require('./routes/admin.routes'));

app.use(notFoundHandler);
app.use(errorHandler); // must be last

module.exports = app;
