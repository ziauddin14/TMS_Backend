const { exportReportQuerySchema, userSummaryQuerySchema } = require('../../src/validators/report.validator');

// Prompt — regression test for a real bug found while wiring lastUpdateOnly through: axios sends
// an explicit JS `false` query param as the literal string "false" (it only omits undefined/null,
// never false), and z.coerce.boolean() does `Boolean(value)` — which makes the STRING "false"
// coerce to `true`. That would have silently flipped every unchecked "صرف آخری اپڈیٹ" export into
// last-update-only mode. booleanQueryField (an enum(['true','false']) + transform) is the fix.
describe('exportReportQuerySchema — lastUpdateOnly (docs/05-apis.md §9)', () => {
  it('the literal string "false" parses to boolean false, NOT true', () => {
    const result = exportReportQuerySchema.parse({ format: 'excel', lastUpdateOnly: 'false' });
    expect(result.lastUpdateOnly).toBe(false);
  });

  it('the literal string "true" parses to boolean true', () => {
    const result = exportReportQuerySchema.parse({ format: 'excel', lastUpdateOnly: 'true' });
    expect(result.lastUpdateOnly).toBe(true);
  });

  it('omitted entirely defaults to false', () => {
    const result = exportReportQuerySchema.parse({ format: 'excel' });
    expect(result.lastUpdateOnly).toBe(false);
  });

  it('rejects a nonsense value rather than silently coercing it', () => {
    const result = exportReportQuerySchema.safeParse({ format: 'excel', lastUpdateOnly: 'yes' });
    expect(result.success).toBe(false);
  });

  it('accepts docx as a format', () => {
    const result = exportReportQuerySchema.safeParse({ format: 'docx' });
    expect(result.success).toBe(true);
  });

  it('rejects reportType/columns — no longer part of this schema', () => {
    const result = exportReportQuerySchema.safeParse({ format: 'excel', reportType: 'summary', columns: 'title' });
    expect(result.success).toBe(false);
  });
});

describe('userSummaryQuerySchema — untouched by the task-report rewrite', () => {
  it('rejects docx (only the task report supports it)', () => {
    const result = userSummaryQuerySchema.safeParse({ format: 'docx' });
    expect(result.success).toBe(false);
  });

  it('accepts excel/pdf/jpeg', () => {
    ['excel', 'pdf', 'jpeg'].forEach((format) => {
      expect(userSummaryQuerySchema.safeParse({ format }).success).toBe(true);
    });
  });
});
