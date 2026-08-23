const express = require('express');

const reportsController = require('../controllers/reports.controller');
const authMiddleware = require('../middleware/auth.middleware');
const requireRole = require('../middleware/role.middleware');
const validate = require('../middleware/validate.middleware');
const { exportReportQuerySchema, userSummaryQuerySchema } = require('../validators/report.validator');

const router = express.Router();

router.use(authMiddleware);

// docs/05-apis.md §9 — same scoping as tasks (enforced in report.service.js via listTasks reuse).
router.get('/export', validate(exportReportQuerySchema, 'query'), reportsController.exportReport);

// docs/05-apis.md §9 — Admin only.
router.get(
  '/user-summary',
  requireRole('admin'),
  validate(userSummaryQuerySchema, 'query'),
  reportsController.exportUserSummary
);

module.exports = router;
