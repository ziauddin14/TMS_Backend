const { z } = require('zod');
const { listTasksQuerySchema } = require('./task.validator');

const formatEnum = z.enum(['excel', 'pdf', 'jpeg']);
const columnsField = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined));

// docs/05-apis.md §9: "all the same filters as GET /tasks" — reuses task.validator.js's schema
// wholesale (rather than re-declaring each field) and drops page/limit, since a report is
// unpaginated by design (docs/06-backend.md §9 step 1: "unpaginated, all matching rows").
const exportReportQuerySchema = listTasksQuerySchema
  .omit({ page: true, limit: true })
  .extend({
    format: formatEnum,
    reportType: z.enum(['summary', 'detailed']),
    columns: columnsField,
  });

// docs/05-apis.md §9 — GET /reports/user-summary: format, optional columns hide-list.
const userSummaryQuerySchema = z
  .object({
    format: formatEnum,
    columns: columnsField,
  })
  .strict();

module.exports = { exportReportQuerySchema, userSummaryQuerySchema };
