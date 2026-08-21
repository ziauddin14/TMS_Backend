const { z } = require('zod');

// docs/05-apis.md §3 — POST /users body is exactly { name, email, responsibility, role }.
// .strict() rejects any other field outright (e.g. isActive, id) rather than silently ignoring it.
const createUserSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required'),
    email: z.string().email('A valid email is required'),
    responsibility: z.string().trim().min(1, 'Responsibility is required'),
    role: z.enum(['admin', 'user'], { errorMap: () => ({ message: 'Role must be admin or user' }) }),
  })
  .strict();

// docs/05-apis.md §3 — PATCH /users/:id may change name, responsibility, role, isActive only.
// email is explicitly NOT in this schema, and .strict() means an email field in the request body
// is REJECTED with a validation error rather than silently ignored or silently accepted — per the
// Phase 4 instructions' explicit requirement (see Phase 4 report, section E).
const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    responsibility: z.string().trim().min(1).optional(),
    role: z.enum(['admin', 'user']).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

// docs/05-apis.md §3 — GET /users query params: role, isActive, search, plus pagination
// (docs/05-apis.md §1: page default 1, limit default 20 max 100).
const listUsersQuerySchema = z
  .object({
    role: z.enum(['admin', 'user']).optional(),
    isActive: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    search: z.string().trim().min(1).optional(),
    page: z.coerce.number().int().positive().optional().default(1),
    limit: z.coerce.number().int().positive().max(100).optional().default(20),
  })
  .strict();

module.exports = { createUserSchema, updateUserSchema, listUsersQuerySchema };
