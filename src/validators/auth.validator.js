const { z } = require('zod');

// docs/05-apis.md §2: POST /auth/google body is exactly { idToken }. No other field is accepted.
const googleLoginSchema = z.object({
  idToken: z.string().min(1, 'idToken is required'),
});

// docs/12-testing.md §5: POST /auth/dev-login body is exactly { email }.
const devLoginSchema = z.object({
  email: z.string().email('A valid email is required'),
});

module.exports = { googleLoginSchema, devLoginSchema };
