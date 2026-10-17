const express = require('express');

const adminController = require('../controllers/admin.controller');
const activityController = require('../controllers/activity.controller');
const authMiddleware = require('../middleware/auth.middleware');
const requireRole = require('../middleware/role.middleware');
const requireCronSecretOrAdmin = require('../middleware/cronAuth.middleware');
const { cronTriggerRateLimiter, receiptReminderTriggerRateLimiter } = require('../middleware/rateLimiter.middleware');
const validate = require('../middleware/validate.middleware');
const {
  adminSendNotificationSchema,
  taskReminderSchema,
  listNotificationHistoryQuerySchema,
} = require('../validators/notification.validator');
const {
  listActivityUsersQuerySchema,
  listActivityEventsQuerySchema,
  activityHistoryQuerySchema,
  updateActivitySettingsSchema,
} = require('../validators/activity.validator');

const router = express.Router();

// docs/05-apis.md §10 — dual-authenticated: Admin JWT (unchanged) OR the GitHub Actions cron
// secret (X-Cron-Secret header). Deliberately registered BEFORE router.use(authMiddleware) below,
// so a cron-secret request never has to carry (or fail) a JWT at all — requireCronSecretOrAdmin
// itself falls through to the exact same authMiddleware + requireRole('admin') chain whenever the
// header is absent, so the existing Admin-login path is byte-for-byte unchanged.
router.post('/trigger-reminders', cronTriggerRateLimiter, requireCronSecretOrAdmin, adminController.triggerReminders);

// Task receipt reminders only — called hourly by .github/workflows/receipt-reminder-cron.yml, with
// the same X-Cron-Secret (or an Admin session), before the JWT-only routes below for the same
// reason as trigger-reminders above.
router.post(
  '/trigger-receipt-reminders',
  receiptReminderTriggerRateLimiter,
  requireCronSecretOrAdmin,
  adminController.triggerReceiptReminders
);

router.use(authMiddleware);

// Locked blueprint §Phase 2 — manual notification flows, all admin only.
router.post(
  '/notifications',
  requireRole('admin'),
  validate(adminSendNotificationSchema),
  adminController.sendAdminNotification
);
router.post(
  '/tasks/:taskId/reminder',
  requireRole('admin'),
  validate(taskReminderSchema),
  adminController.sendTaskReminder
);
router.get(
  '/notifications/history',
  requireRole('admin'),
  validate(listNotificationHistoryQuerySchema, 'query'),
  adminController.getNotificationHistory
);

// Activity log — Admin only, every one of them (a normal user gets 403 FORBIDDEN_ROLE).
router.get('/activity/summary', requireRole('admin'), activityController.getSummary);
router.get('/activity/users', requireRole('admin'), validate(listActivityUsersQuerySchema, 'query'), activityController.listUsers);
router.get(
  '/activity/users/:id/events',
  requireRole('admin'),
  validate(listActivityEventsQuerySchema, 'query'),
  activityController.listEvents
);
router.get(
  '/activity/users/:id/history',
  requireRole('admin'),
  validate(activityHistoryQuerySchema, 'query'),
  activityController.listHistory
);
router.get('/settings/activity', requireRole('admin'), activityController.getSettings);
router.patch('/settings/activity', requireRole('admin'), validate(updateActivitySettingsSchema), activityController.updateSettings);

module.exports = router;
