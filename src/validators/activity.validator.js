const { z } = require('zod');
const { ACTIVITY_TYPES } = require('../utils/activityTypes');
const { MIN_INACTIVITY_DAYS, MAX_INACTIVITY_DAYS } = require('../services/appSetting.service');

// The activity log's admin endpoints (routes/admin.routes.js).

const page = z.coerce.number().int().positive().optional().default(1);
// A Pakistan calendar date, as a native <input type="date"> sends it.
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

// GET /admin/activity/users
const listActivityUsersQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(100).optional(),
    inactiveOnly: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
    page,
    limit: z.coerce.number().int().positive().max(100).optional().default(20),
  })
  .strict();

// GET /admin/activity/users/:id/events
const listActivityEventsQuerySchema = z
  .object({
    type: z.enum(Object.values(ACTIVITY_TYPES)).optional(),
    from: dateParam.optional(),
    to: dateParam.optional(),
    page,
    limit: z.coerce.number().int().positive().max(100).optional().default(20),
  })
  .strict();

// GET /admin/activity/users/:id/history
const activityHistoryQuerySchema = z
  .object({
    page,
    limit: z.coerce.number().int().positive().max(50).optional().default(10),
  })
  .strict();

// PATCH /admin/settings/activity — a whole number of days, 1 to 90.
const updateActivitySettingsSchema = z
  .object({
    inactivityDays: z
      .number({ required_error: 'inactivityDays is required', invalid_type_error: 'inactivityDays must be a number' })
      .int('inactivityDays must be a whole number')
      .min(MIN_INACTIVITY_DAYS, `inactivityDays must be between ${MIN_INACTIVITY_DAYS} and ${MAX_INACTIVITY_DAYS}`)
      .max(MAX_INACTIVITY_DAYS, `inactivityDays must be between ${MIN_INACTIVITY_DAYS} and ${MAX_INACTIVITY_DAYS}`),
  })
  .strict();

module.exports = {
  listActivityUsersQuerySchema,
  listActivityEventsQuerySchema,
  activityHistoryQuerySchema,
  updateActivitySettingsSchema,
};
