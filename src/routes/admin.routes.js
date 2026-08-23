const express = require('express');

const adminController = require('../controllers/admin.controller');
const authMiddleware = require('../middleware/auth.middleware');
const requireRole = require('../middleware/role.middleware');

const router = express.Router();

router.use(authMiddleware);

// docs/05-apis.md §10 — Admin only.
router.post('/trigger-reminders', requireRole('admin'), adminController.triggerReminders);

module.exports = router;
