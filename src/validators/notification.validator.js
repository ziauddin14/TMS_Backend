const { z } = require('zod');

// z.coerce.boolean() is a trap for a query-string flag — see report.validator.js's own comment
// on this exact pattern (`Boolean("false")` is `true`). Reused here identically: only the literal
// string "true" means true; anything else (missing, "false") means false.
const booleanQueryField = z.enum(['true', 'false']).optional().transform((v) => v === 'true');

// GET /notifications query params.
const listNotificationsQuerySchema = z
  .object({
    unreadOnly: booleanQueryField,
    page: z.coerce.number().int().positive().optional().default(1),
    limit: z.coerce.number().int().positive().max(100).optional().default(20),
  })
  .strict();

// POST /admin/notifications body — Flow A ('all') and Flow B ('user') share one endpoint/schema,
// matching the locked blueprint's API design. Shape only: whether userId is actually a real,
// active, role:'user' account, and whether templateKey/message resolve to real content, are
// business rules checked in notification.service.js (sendToSpecificUser/resolveContent) — not
// duplicated here, matching this codebase's existing validator/service layering (e.g.
// task.validator.js never checks whether an assignee id is a real user either).
const adminSendNotificationSchema = z
  .object({
    recipientType: z.enum(['all', 'user']),
    userId: z.string().min(1).optional(),
    templateKey: z.string().min(1).optional(),
    message: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((data) => data.recipientType !== 'user' || Boolean(data.userId), {
    message: 'userId is required when recipientType is "user".',
    path: ['userId'],
  });

// POST /admin/tasks/:taskId/reminder body — Flow C. Deliberately no recipient field of any kind:
// the client sends only content, the server resolves recipients from the task's own assignees.
const taskReminderSchema = z
  .object({
    templateKey: z.string().min(1).optional(),
    message: z.string().trim().min(1).optional(),
  })
  .strict();

// GET /admin/notifications/history query params.
const listNotificationHistoryQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional().default(1),
    limit: z.coerce.number().int().positive().max(100).optional().default(20),
  })
  .strict();

module.exports = {
  listNotificationsQuerySchema,
  adminSendNotificationSchema,
  taskReminderSchema,
  listNotificationHistoryQuerySchema,
};
