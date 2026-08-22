const express = require('express');

const dashboardController = require('../controllers/dashboard.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

// docs/05-apis.md §8 — any authenticated role; scoping happens in dashboard.service.js.
router.get('/summary', authMiddleware, dashboardController.getSummary);

module.exports = router;
