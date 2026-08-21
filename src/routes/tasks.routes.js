const express = require('express');

const tasksController = require('../controllers/task.controller');
const authMiddleware = require('../middleware/auth.middleware');
const requireRole = require('../middleware/role.middleware');
const validate = require('../middleware/validate.middleware');
const {
  createTaskSchema,
  updateTaskSchema,
  listTasksQuerySchema,
} = require('../validators/task.validator');

const router = express.Router();

router.use(authMiddleware); // every /tasks route requires authentication (docs/05-apis.md §5)

router.get('/', validate(listTasksQuerySchema, 'query'), tasksController.listTasks);

// Admin-or-assignee-membership is enforced in task.service.js, not a plain role check.
router.get('/:id', tasksController.getTask);

router.post('/', requireRole('admin'), validate(createTaskSchema), tasksController.createTask);
router.patch('/:id', requireRole('admin'), validate(updateTaskSchema), tasksController.updateTask);
router.patch('/:id/close', requireRole('admin'), tasksController.closeTask);

module.exports = router;
