// Locked blueprint §3 — the notification `type` registry. Kept as a plain object, not a
// Mongoose schema enum (see models/Notification.js's own comment for why): Phase 1 only defines
// these constants and validates against them at the service layer (notification.service.js);
// nothing in Phase 1 actually creates a notification of any type yet (no caller exists before
// Phase 2/3). Future types (TASK_ASSIGNED, TASK_REASSIGNED, TASK_UPDATED, SYSTEM_NOTIFICATION —
// explicitly out of scope through Phase 3) can be added here later with no schema migration.
const NOTIFICATION_TYPES = Object.freeze({
  ADMIN_BROADCAST: 'ADMIN_BROADCAST',
  USER_REMINDER: 'USER_REMINDER',
  TASK_REMINDER: 'TASK_REMINDER',
  TASK_DUE_SOON: 'TASK_DUE_SOON',
  TASK_DUE_TOMORROW: 'TASK_DUE_TOMORROW',
  TASK_OVERDUE: 'TASK_OVERDUE',
});

// Unlike `type`, `source` is a small, genuinely closed set intrinsic to the architecture itself
// (who/what created the row) rather than a business-facing category expected to keep growing —
// kept as an actual Mongoose enum on the model, this registry just avoids repeating the two
// string literals across files.
const NOTIFICATION_SOURCES = Object.freeze({
  ADMIN: 'admin',
  SYSTEM: 'system',
});

module.exports = { NOTIFICATION_TYPES, NOTIFICATION_SOURCES };
