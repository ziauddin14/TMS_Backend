const { z } = require('zod');

// POST /push/subscribe body — the browser's raw PushSubscription.toJSON() shape (endpoint +
// keys.p256dh + keys.auth). `.strict()` on the outer object only — `deviceInfo` is genuinely
// optional/client-supplied free text, never trusted for anything but display.
const subscribeSchema = z
  .object({
    endpoint: z.string().url(),
    keys: z
      .object({
        p256dh: z.string().min(1),
        auth: z.string().min(1),
      })
      .strict(),
    deviceInfo: z.string().trim().max(200).optional(),
  })
  .strict();

// POST /push/unsubscribe body — just enough to identify which of this user's own subscriptions to
// remove; ownership is re-checked server-side (push.service.js), never trusted from the endpoint
// value alone.
const unsubscribeSchema = z
  .object({
    endpoint: z.string().url(),
  })
  .strict();

module.exports = { subscribeSchema, unsubscribeSchema };
