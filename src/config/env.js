const path = require('path');
const dotenv = require('dotenv');
const { z } = require('zod');

// Jest sets NODE_ENV=test automatically when it isn't already set, which lets us load a
// dedicated, committed .env.test (dummy values only — never real secrets) so the test suite
// never depends on a developer's local .env and never touches real credentials.
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(__dirname, '../../', envFile) });

const envSchema = z.object({
  // ---- Server ----
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),

  // ---- Database ----
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  // ---- Auth (JWT) ----
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().min(1).default('7d'),

  // ---- Auth (Google OAuth) ----
  // GOOGLE_CLIENT_ID is required as of the Auth module (Phase 3) — it's the audience checked on
  // every Google ID token verification. GOOGLE_ALLOWED_HD stays permanently optional per the
  // approved decision: empty/undefined = no domain restriction; never hardcode a domain in code.
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_ALLOWED_HD: z.string().optional(),

  // ---- Google Drive (service account) ----
  // Required as of the Attachments module (Phase 6) — consumed by googleDrive.service.js.
  GOOGLE_DRIVE_CLIENT_EMAIL: z.string().min(1, 'GOOGLE_DRIVE_CLIENT_EMAIL is required'),
  GOOGLE_DRIVE_PRIVATE_KEY: z.string().min(1, 'GOOGLE_DRIVE_PRIVATE_KEY is required'),
  GOOGLE_DRIVE_FOLDER_ID: z.string().min(1, 'GOOGLE_DRIVE_FOLDER_ID is required'),

  // ---- Email / SMTP ----
  // Optional for now: not consumed until the Notifications module is implemented.
  // Kept as plain strings here (not number-coerced) since nothing parses them yet — that
  // conversion belongs to whichever phase actually consumes SMTP_PORT.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  // ---- App behaviour ----
  FRONTEND_URL: z.string().url('FRONTEND_URL must be a valid URL'),
  // Configurable reminder lead time — never hardcode this inside business logic.
  REMINDER_DAYS_BEFORE: z.coerce.number().int().positive().default(2),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
  throw new Error(
    `Environment validation failed. Check .env against .env.example.\n${details}`
  );
}

module.exports = parsed.data;
