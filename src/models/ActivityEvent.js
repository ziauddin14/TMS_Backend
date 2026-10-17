const mongoose = require('mongoose');
const applyToJSON = require('./plugins/applyToJSON');
const { ACTIVITY_TYPES } = require('../utils/activityTypes');

const { Schema } = mongoose;

// Activity log — one document per meaningful action a signed-in person took (log in, create a task,
// post an update, ...). Written only by services/activity.service.js, always fire-and-forget, and
// only from request handlers that have a signed-in user: scripts and the cron endpoints never write
// here.
//
// Privacy: `device` is the PARSED browser / OS / device type and nothing more — never the raw
// user-agent string, never an IP address. `metadata` holds only small, safe fields (a task code,
// the NAMES of changed fields, a target user id, counts, a template key, an export format, filter
// KEYS, estimate percentages, a setting's old/new value) — never message text, search text, tokens
// or file contents (activity.service.js sanitizes it as well).
const deviceSchema = new Schema(
  {
    browser: { type: String, default: 'Other' },
    os: { type: String, default: 'Other' },
    deviceType: { type: String, enum: ['desktop', 'mobile', 'tablet'], default: 'desktop' },
  },
  { _id: false }
);

const activityEventSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: Object.values(ACTIVITY_TYPES), required: true },
    at: { type: Date, required: true, default: Date.now },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    device: { type: deviceSchema, default: () => ({}) },
  },
  { timestamps: false }
);

// A person's timeline, newest first (and their latest event, for the "last action" column).
activityEventSchema.index({ user: 1, at: -1 });

// Keep events for one year, then MongoDB deletes them on its own (a TTL index). Mongoose builds this
// index automatically at startup (autoIndex is on — config/db.js) the first time the collection is
// used. NOTE: Mongoose never CHANGES an existing index — changing this lifetime later is a manual
// step on the database (collMod, or drop and let it be rebuilt). It also serves date-range filters.
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
activityEventSchema.index({ at: 1 }, { expireAfterSeconds: ONE_YEAR_SECONDS });

applyToJSON(activityEventSchema);

module.exports = mongoose.models.ActivityEvent || mongoose.model('ActivityEvent', activityEventSchema);
module.exports.ONE_YEAR_SECONDS = ONE_YEAR_SECONDS;
