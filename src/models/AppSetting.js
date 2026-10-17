const mongoose = require('mongoose');
const applyToJSON = require('./plugins/applyToJSON');

const { Schema } = mongoose;

// Small app-wide settings, one document per key (the app had no settings store before the activity
// log). Read and written through services/appSetting.service.js only. Current keys:
//   - inactivityDays     — the activity log's "inactive for more than N days" threshold; absent
//                          until an admin saves one (the default, 7, is applied in code);
//   - activityBaselineAt — when activity recording began (the feature's deploy), set once,
//                          atomically, at server start; never changed afterwards.
const appSettingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    value: { type: Schema.Types.Mixed, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

applyToJSON(appSettingSchema);

module.exports = mongoose.models.AppSetting || mongoose.model('AppSetting', appSettingSchema);
