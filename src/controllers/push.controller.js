const pushService = require('../services/push.service');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

// POST /push/subscribe — req.user.id is always the owner, never a client-supplied userId.
const subscribe = asyncHandler(async (req, res) => {
  const { endpoint, keys, deviceInfo } = req.body;
  await pushService.saveSubscription(req.user.id, { endpoint, keys, deviceInfo });
  sendSuccess(res, { data: { subscribed: true }, statusCode: 201 });
});

// POST /push/unsubscribe — ownership re-verified inside the service (push.service.js's
// removeSubscription), the exact same "scope to req.user.id, never trust the client" pattern
// notification.service.js's own markRead already uses.
const unsubscribe = asyncHandler(async (req, res) => {
  const { endpoint } = req.body;
  await pushService.removeSubscription(req.user.id, endpoint);
  sendSuccess(res, { data: { subscribed: false } });
});

module.exports = { subscribe, unsubscribe };
