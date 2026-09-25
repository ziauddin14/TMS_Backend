const express = require('express');

const pushController = require('../controllers/push.controller');
const authMiddleware = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const { subscribeSchema, unsubscribeSchema } = require('../validators/push.validator');

const router = express.Router();

router.use(authMiddleware); // every /push route requires authentication; self-scoped only

router.post('/subscribe', validate(subscribeSchema), pushController.subscribe);
router.post('/unsubscribe', validate(unsubscribeSchema), pushController.unsubscribe);

module.exports = router;
