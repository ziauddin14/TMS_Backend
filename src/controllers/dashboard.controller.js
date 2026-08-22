const dashboardService = require('../services/dashboard.service');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

// GET /dashboard/summary — docs/05-apis.md §8
const getSummary = asyncHandler(async (req, res) => {
  const summary = await dashboardService.getDashboardSummary(req.user);
  sendSuccess(res, { data: summary });
});

module.exports = { getSummary };
