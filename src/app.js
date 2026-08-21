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
  allowedOrigins.push('http://localhost:5173');
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

// Remaining resource routers are mounted here in later phases, under the same /api/v1 prefix
// (docs/05-apis.md §1), e.g.:
//   app.use('/api/v1/reports', require('./routes/reports.routes'));

app.use(notFoundHandler);
app.use(errorHandler); // must be last

module.exports = app;
