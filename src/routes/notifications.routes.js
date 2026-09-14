const express = require('express');

const notificationController = require('../controllers/notification.controller');
const authMiddleware = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const { listNotificationsQuerySchema } = require('../validators/notification.validator');

const router = express.Router();

router.use(authMiddleware); // every /notifications route requires authentication; self-scoped only

router.get('/unread-count', notificationController.getUnreadCount);
router.get('/', validate(listNotificationsQuerySchema, 'query'), notificationController.listNotifications);
router.patch('/read-all', notificationController.markAllRead);
router.patch('/:id/read', notificationController.markRead);

module.exports = router;
