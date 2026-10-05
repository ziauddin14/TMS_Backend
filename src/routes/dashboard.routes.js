const express = require('express');

const dashboardController = require('../controllers/dashboard.controller');
const authMiddleware = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const { dashboardSummaryQuerySchema } = require('../validators/dashboard.validator');

const router = express.Router();

// docs/05-apis.md §8 — any authenticated role; scoping happens in dashboard.service.js. Takes the
// same filter query params as GET /tasks, so the KPI figures describe exactly the listed tasks.
router.get('/summary', authMiddleware, validate(dashboardSummaryQuerySchema, 'query'), dashboardController.getSummary);

module.exports = router;
