const express = require('express');

const adminController = require('../controllers/admin.controller');
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

module.exports = router;
