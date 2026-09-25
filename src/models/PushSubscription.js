const mongoose = require('mongoose');
const applyToJSON = require('./plugins/applyToJSON');

const { Schema } = mongoose;

// Web Push addition (progressive-enhancement layer on top of the existing Notification/bell-drawer
// system, never a replacement for it — see push.service.js). A browser's PushSubscription object
// (endpoint + keys.p256dh + keys.auth) is what the Push API returns from
// `registration.pushManager.subscribe(...)`; it is unique per browser-instance-per-site, so one
// user with a phone + a laptop legitimately has two separate rows here, each independently
// deliverable to and independently prunable (a dead/expired endpoint on one device must never
// affect the other).
const pushSubscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    endpoint: { type: String, required: true, trim: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    // Optional, client-supplied, purely informational (e.g. a User-Agent snippet) — lets a future
    // Settings UI show "iPhone", "Chrome on Windows" etc. instead of an opaque row; never used in
    // any send/delete decision.
    deviceInfo: { type: String, default: null },
  },
  { timestamps: true }
);

// A user's own subscriptions, for sending and for the Settings page's own on/off status lookup.
pushSubscriptionSchema.index({ userId: 1 });
// One row per unique browser subscription — re-subscribing the same device (e.g. after a page
// reload) upserts by endpoint (push.service.js's saveSubscription) rather than accumulating
// duplicate rows for what is really the same device.
pushSubscriptionSchema.index({ endpoint: 1 }, { unique: true });

applyToJSON(pushSubscriptionSchema);

module.exports = mongoose.models.PushSubscription || mongoose.model('PushSubscription', pushSubscriptionSchema);
