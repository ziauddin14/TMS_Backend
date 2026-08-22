const { z } = require('zod');

// docs/04-db-models.md §4 — attachment sub-schema, optional.
const attachmentSchema = z
  .object({
    driveFileId: z.string().min(1),
    fileName: z.string().min(1),
    url: z.string().url(),
  })
  .strict();

// docs/05-apis.md §6 — POST /tasks/:id/updates body.
const createTaskUpdateSchema = z
  .object({
    description: z.string().trim().min(1, 'Description is required'),
    completionPercent: z.coerce.number().min(0).max(100),
    attachment: attachmentSchema.optional(),
  })
  .strict();

// docs/05-apis.md §6 — GET /tasks/:id/updates: pagination, default sorted newest-first.
const listTaskUpdatesQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional().default(1),
    limit: z.coerce.number().int().positive().max(100).optional().default(20),
  })
  .strict();

module.exports = { createTaskUpdateSchema, listTaskUpdatesQuerySchema };
