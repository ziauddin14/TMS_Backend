const { z } = require('zod');
const { taskFilterFields } = require('./task.validator');

// GET /dashboard/summary — exactly the task filters GET /tasks accepts (and nothing else: no
// sort, no paging), so the KPI figures are always computed over the same set the table lists.
const dashboardSummaryQuerySchema = z.object(taskFilterFields).strict();

module.exports = { dashboardSummaryQuerySchema };
