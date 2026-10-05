const { z } = require('zod');

// Existence/active-status of each id is checked in task.service.js (docs/06-backend.md §4.2
// step 1) — this schema only checks shape, so a malformed id reaches the service's uniform
// VALIDATION_ERROR-with-details path rather than being rejected here with a different shape.
const assigneeIdSchema = z.string().min(1);

// docs/05-apis.md §5 — POST /tasks body is exactly { title, assignees, responsibility, deadline }.
const createTaskSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required'),
    assignees: z.array(assigneeIdSchema).min(1, 'At least one assignee is required'),
    responsibility: z.string().trim().min(1, 'Responsibility is required'),
    deadline: z.coerce.date({ errorMap: () => ({ message: 'A valid deadline date is required' }) }),
  })
  .strict();

// docs/05-apis.md §5 — PATCH /tasks/:id may change title/assignees/responsibility/deadline only.
const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    assignees: z.array(assigneeIdSchema).min(1).optional(),
    responsibility: z.string().trim().min(1).optional(),
    deadline: z.coerce.date().optional(),
  })
  .strict();

// The task FILTERS, on their own — the one definition shared by every endpoint that selects a set
// of tasks: GET /tasks below, GET /reports/export (report.validator.js extends listTasksQuerySchema)
// and GET /dashboard/summary (dashboard.validator.js), so the KPI cards, the table and an export
// always describe the same set for the same query string.
// ratingSource — 'synthetic': only tasks whose rating is a developer-assigned (synthetic) one;
// 'real': only tasks with a real rating (rated, and not synthetic).
const taskFilterFields = {
  status: z.enum(['ongoing', 'pending', 'complete', 'closed']).optional(),
  performanceRating: z.enum(['excellent', 'good', 'fair', 'weak', '-']).optional(),
  ratingSource: z.enum(['synthetic', 'real']).optional(),
  assigneeId: z.string().min(1).optional(),
  responsibility: z.string().trim().min(1).optional(),
  deadlineFrom: z.coerce.date().optional(),
  deadlineTo: z.coerce.date().optional(),
  entryFrom: z.coerce.date().optional(),
  entryTo: z.coerce.date().optional(),
  search: z.string().trim().min(1).optional(),
};

// docs/05-apis.md §5 — GET /tasks query params.
const listTasksQuerySchema = z
  .object({
    ...taskFilterFields,
    sortBy: z
      .enum(['deadline', 'createdAt', 'codeNumber', 'title', 'completionPercent', 'status', 'performanceRating'])
      .optional()
      .default('deadline'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('asc'),
    page: z.coerce.number().int().positive().optional().default(1),
    limit: z.coerce.number().int().positive().max(100).optional().default(20),
  })
  .strict();

// PATCH /tasks/:id/synthetic-rating — Admin only. A JSON number (not a numeric string), 0–100.
const editSyntheticRatingSchema = z
  .object({
    assumedPercent: z
      .number({ required_error: 'assumedPercent is required', invalid_type_error: 'assumedPercent must be a number' })
      .min(0, 'assumedPercent must be between 0 and 100')
      .max(100, 'assumedPercent must be between 0 and 100'),
    note: z.string().trim().max(500, 'note must be 500 characters or fewer').optional(),
  })
  .strict();

// DELETE /tasks/:id/synthetic-rating — Admin only. The body is optional (a DELETE often has none).
const removeSyntheticRatingSchema = z
  .object({
    note: z.string().trim().max(500, 'note must be 500 characters or fewer').optional(),
  })
  .strict()
  .optional()
  .transform((body) => body ?? {});

module.exports = {
  createTaskSchema,
  updateTaskSchema,
  listTasksQuerySchema,
  taskFilterFields,
  editSyntheticRatingSchema,
  removeSyntheticRatingSchema,
};
