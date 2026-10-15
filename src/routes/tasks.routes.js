const express = require('express');

const tasksController = require('../controllers/task.controller');
const authMiddleware = require('../middleware/auth.middleware');
const requireRole = require('../middleware/role.middleware');
const validate = require('../middleware/validate.middleware');
const {
  createTaskSchema,
  updateTaskSchema,
  listTasksQuerySchema,
  editSyntheticRatingSchema,
  removeSyntheticRatingSchema,
  acknowledgeTaskSchema,
} = require('../validators/task.validator');

const router = express.Router();

router.use(authMiddleware); // every /tasks route requires authentication (docs/05-apis.md §5)

router.get('/', validate(listTasksQuerySchema, 'query'), tasksController.listTasks);

// Admin-or-assignee-membership is enforced in task.service.js, not a plain role check.
router.get('/:id', tasksController.getTask);

router.post('/', requireRole('admin'), validate(createTaskSchema), tasksController.createTask);
router.patch('/:id', requireRole('admin'), validate(updateTaskSchema), tasksController.updateTask);
router.patch('/:id/close', requireRole('admin'), tasksController.closeTask);

// Task receipt — any signed-in person, for their OWN receipt only (receipt.service.js acknowledge):
// someone not on the task gets 403, someone on it with nothing to confirm 409.
router.post('/:id/acknowledge', validate(acknowledgeTaskSchema), tasksController.acknowledgeTask);

// A developer-assigned (synthetic) rating — Admin only, and only on a task that carries one
// (409 otherwise). Change its assumed percentage, or remove it (the task goes back to unrated).
router.patch(
  '/:id/synthetic-rating',
  requireRole('admin'),
  validate(editSyntheticRatingSchema),
  tasksController.editSyntheticRating
);
router.delete(
  '/:id/synthetic-rating',
  requireRole('admin'),
  validate(removeSyntheticRatingSchema),
  tasksController.removeSyntheticRating
);

module.exports = router;
