const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');
const env = require('../config/env');
const logger = require('../utils/logger');

// web-push requires the VAPID subject to be an https: or mailto: URL — production's FRONTEND_URL
// (https://tms-donationbox.vercel.app) satisfies that directly, but local dev's and .env.test's
// FRONTEND_URL is a plain http://localhost URL, which setVapidDetails() rejects outright. Falls
// back to a placeholder mailto: only in that non-https case, so real (production) behavior is
// exactly "use FRONTEND_URL" while local/test environments still load at all.
const VAPID_SUBJECT = env.FRONTEND_URL.startsWith('https:') ? env.FRONTEND_URL : 'mailto:admin@tms.local';

// Set once at module load, same pattern as email.service.js's transporter — cheap, no network
// call, safe against the dummy-but-genuinely-valid test keys in .env.test.
webpush.setVapidDetails(VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

// POST /push/subscribe — upsert by endpoint (not insert), so re-subscribing the same device (a
// page reload, a token refresh) updates the existing row instead of accumulating duplicates. A
// user can legitimately have many rows (phone + laptop + ...), each with a distinct endpoint.
async function saveSubscription(userId, { endpoint, keys, deviceInfo }) {
  return PushSubscription.findOneAndUpdate(
    { endpoint },
    { userId, endpoint, keys, deviceInfo: deviceInfo ?? null },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

// POST /push/unsubscribe — ownership-scoped (matches this codebase's own markRead convention):
// filters on BOTH endpoint and userId together, so a request can never remove another user's
// subscription even if it somehow knew the endpoint value. Silently a no-op if already gone
// (idempotent, mirrors "off" being pressed twice).
async function removeSubscription(userId, endpoint) {
  const result = await PushSubscription.deleteOne({ endpoint, userId });
  return { deletedCount: result.deletedCount };
}

// Settings page's own on/off status for the CURRENT device — existence of any row for this user is
// enough to show "on" in aggregate; the page itself only cares about its own browser's endpoint,
// resolved client-side from the current Service Worker registration, not from this list.
async function listSubscriptionsForUser(userId) {
  return PushSubscription.find({ userId });
}

// The web-push delivery channel (locked blueprint addition on top of the existing in-app
// Notification system, never a replacement for it). Deliberately never awaited by its caller
// (notification.service.js) — a slow or failing push send must never delay or break the primary
// DB-backed notification write. Sends to every device this user has subscribed from, in parallel;
// one device's failure is isolated from the others (Promise.allSettled, not Promise.all).
async function sendPushToUser(userId, payload) {
  const subscriptions = await PushSubscription.find({ userId });
  if (subscriptions.length === 0) return;

  const body = JSON.stringify(payload);

  await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
          },
          body
        );
      } catch (err) {
        // 410 Gone is the push service's documented "this subscription will never work again"
        // response (browser unsubscribed, uninstalled, or the endpoint simply expired); some push
        // services return 404 for the same condition. Either way the row is dead weight — remove
        // it so the next send doesn't keep retrying a subscription that can never succeed. Any
        // OTHER error (network hiccup, a transient 5xx from the push service) is logged only —
        // deleting on a transient failure would wrongly unsubscribe a device that is still valid.
        if (err.statusCode === 410 || err.statusCode === 404) {
          await PushSubscription.deleteOne({ _id: subscription._id });
        } else {
          logger.error(`Push send failed for subscription ${subscription._id}:`, err.message || err);
        }
      }
    })
  );
}

module.exports = { saveSubscription, removeSubscription, listSubscriptionsForUser, sendPushToUser };
