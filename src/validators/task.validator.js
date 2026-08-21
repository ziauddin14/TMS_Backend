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

// docs/05-apis.md §5 — GET /tasks query params.
const listTasksQuerySchema = z
  .object({
    status: z.enum(['ongoing', 'pending', 'complete', 'closed']).optional(),
    performanceRating: z.enum(['excellent', 'good', 'fair', 'weak', '-']).optional(),
    assigneeId: z.string().min(1).optional(),
    responsibility: z.string().trim().min(1).optional(),
    deadlineFrom: z.coerce.date().optional(),
    deadlineTo: z.coerce.date().optional(),
    entryFrom: z.coerce.date().optional(),
    entryTo: z.coerce.date().optional(),
    search: z.string().trim().min(1).optional(),
    sortBy: z
      .enum(['deadline', 'createdAt', 'codeNumber', 'title', 'completionPercent', 'status', 'performanceRating'])
      .optional()
      .default('deadline'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('asc'),
    page: z.coerce.number().int().positive().optional().default(1),
    limit: z.coerce.number().int().positive().max(100).optional().default(20),
  })
  .strict();

module.exports = { createTaskSchema, updateTaskSchema, listTasksQuerySchema };
