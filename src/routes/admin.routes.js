const express = require('express');

const adminController = require('../controllers/admin.controller');
const authMiddleware = require('../middleware/auth.middleware');
const requireRole = require('../middleware/role.middleware');
const validate = require('../middleware/validate.middleware');
const {
  adminSendNotificationSchema,
  taskReminderSchema,
  listNotificationHistoryQuerySchema,
} = require('../validators/notification.validator');

const router = express.Router();

router.use(authMiddleware);

// docs/05-apis.md §10 — Admin only. Phase 3 infrastructure, untouched by the Phase 2 routes below.
router.post('/trigger-reminders', requireRole('admin'), adminController.triggerReminders);

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
