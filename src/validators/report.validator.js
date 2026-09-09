const { z } = require('zod');
const { listTasksQuerySchema } = require('./task.validator');

// docx is only meaningful for the grouped task report below — kept as its own enum (not shared
// with userSummaryFormatEnum) so a docx request can never silently reach
// generateUserSummaryFile, which has no docx branch at all.
const taskReportFormatEnum = z.enum(['excel', 'pdf', 'jpeg', 'docx']);
const userSummaryFormatEnum = z.enum(['excel', 'pdf', 'jpeg']);
const columnsField = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined));

// z.coerce.boolean() is a trap for a query-string flag: it does `Boolean(value)`, so the STRING
// "false" (which axios sends verbatim for a JS `false` param — it never omits false the way it
// omits undefined/null) coerces to `true`, silently flipping the default (unchecked "صرف آخری
// اپڈیٹ") into last-update-only mode on every single export. Only the literal string "true"
// means true; anything else (missing, "false") means false.
const booleanQueryField = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

// docs/05-apis.md §9: "all the same filters as GET /tasks" — reuses task.validator.js's schema
// wholesale (rather than re-declaring each field) and drops page/limit, since a report is
// unpaginated by design (docs/06-backend.md §9 step 1: "unpaginated, all matching rows").
//
// Prompt — reportType/columns are gone: the report is now one fixed grouped-by-Zimmedar
// structure regardless of format, so there's no per-column selection any more. lastUpdateOnly
// replaces reportType as the one thing that still varies — whether each task's Updates section
// shows its full history or just the single most recent entry.
const exportReportQuerySchema = listTasksQuerySchema
  .omit({ page: true, limit: true })
  .extend({
    format: taskReportFormatEnum,
    lastUpdateOnly: booleanQueryField,
  });

// docs/05-apis.md §9 — GET /reports/user-summary: format, optional columns hide-list. Untouched
// by the task-report restructure above — still its own separate flat report.
const userSummaryQuerySchema = z
  .object({
    format: userSummaryFormatEnum,
    columns: columnsField,
  })
  .strict();

module.exports = { exportReportQuerySchema, userSummaryQuerySchema };
