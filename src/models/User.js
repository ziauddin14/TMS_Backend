const mongoose = require('mongoose');
const applyToJSON = require('./plugins/applyToJSON');

const { Schema } = mongoose;

// docs/04-db-models.md §2 — schema is authoritative, transcribed as documented.
const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true, // creates the { email: 1 } unique index (docs/02-db-design.md §10) — no
      // separate schema.index() call is added for it, to avoid Mongoose's duplicate-index warning
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email format'],
    },
    responsibility: { type: String, required: true, trim: true },
    role: { type: String, enum: ['admin', 'user'], required: true, default: 'user' },
    isActive: { type: Boolean, default: true },
    // Activity log (services/activity.service.js). Absent until first set, and only ever written
    // with timestamps:false, so updatedAt never moves for them. lastLoginAt: the last Google sign-in.
    // lastActiveAt: the last authenticated use of the app (throttled to one write per 10 minutes).
    lastLoginAt: { type: Date },
    lastActiveAt: { type: Date },
  },
  { timestamps: true }
);

applyToJSON(userSchema);

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
