const express = require('express');

const usersController = require('../controllers/user.controller');
const authMiddleware = require('../middleware/auth.middleware');
const requireRole = require('../middleware/role.middleware');
const validate = require('../middleware/validate.middleware');
const {
  createUserSchema,
  updateUserSchema,
  listUsersQuerySchema,
} = require('../validators/user.validator');

const router = express.Router();

router.use(authMiddleware); // every /users route requires authentication (docs/05-apis.md §3)

router.get('/', requireRole('admin'), validate(listUsersQuerySchema, 'query'), usersController.listUsers);

// Admin-or-self is an ownership rule, not a plain role check — enforced in user.service.js
// (docs/06-backend.md's layering rule), so no requireRole() here.
router.get('/:id', usersController.getUser);

router.post('/', requireRole('admin'), validate(createUserSchema), usersController.createUser);
router.patch('/:id', requireRole('admin'), validate(updateUserSchema), usersController.updateUser);

module.exports = router;
