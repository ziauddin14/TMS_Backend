const { z } = require('zod');

// docs/04-db-models.md §5: listType enum currently has exactly one value — do not invent others.
const listTypeEnum = z.enum(['responsibility']);

// docs/05-apis.md §4 — POST /lookup-lists body is { listType, value, sortOrder? }.
const createLookupValueSchema = z
  .object({
    listType: listTypeEnum,
    value: z.string().trim().min(1, 'Value is required'),
    sortOrder: z.coerce.number().int().optional(),
  })
  .strict();

// docs/05-apis.md §4 — PATCH /lookup-lists/:id may change value, sortOrder, isActive only.
const updateLookupValueSchema = z
  .object({
    value: z.string().trim().min(1).optional(),
    sortOrder: z.coerce.number().int().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

// docs/05-apis.md §4 — GET /lookup-lists?type=responsibility.
const listLookupQuerySchema = z
  .object({
    type: listTypeEnum,
  })
  .strict();

module.exports = { createLookupValueSchema, updateLookupValueSchema, listLookupQuerySchema };
