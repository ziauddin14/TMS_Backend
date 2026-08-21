const express = require('express');

const lookupListController = require('../controllers/lookupList.controller');
const authMiddleware = require('../middleware/auth.middleware');
const requireRole = require('../middleware/role.middleware');
const validate = require('../middleware/validate.middleware');
const {
  createLookupValueSchema,
  updateLookupValueSchema,
  listLookupQuerySchema,
} = require('../validators/lookupList.validator');

const router = express.Router();

router.use(authMiddleware); // every /lookup-lists route requires authentication (docs/05-apis.md §4)

// Any authenticated role — this powers a dropdown every user needs, not Admin-restricted.
router.get('/', validate(listLookupQuerySchema, 'query'), lookupListController.listActive);

router.post('/', requireRole('admin'), validate(createLookupValueSchema), lookupListController.createValue);
router.patch(
  '/:id',
  requireRole('admin'),
  validate(updateLookupValueSchema),
  lookupListController.updateValue
);

module.exports = router;
