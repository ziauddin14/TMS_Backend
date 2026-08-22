const express = require('express');

const taskUpdateController = require('../controllers/taskUpdate.controller');
const authMiddleware = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const { createTaskUpdateSchema, listTaskUpdatesQuerySchema } = require('../validators/taskUpdate.validator');

// mergeParams:true — mounted at /api/v1/tasks/:id/updates (app.js), so req.params.id is the
// parent task's id. A separate Router instance from tasks.routes.js (Phase 5's file, left
// untouched per the Phase 6 instructions), so auth is (re-)applied here rather than inherited.
const router = express.Router({ mergeParams: true });

router.use(authMiddleware);

// Admin-or-assignee-membership is enforced in taskUpdate.service.js, not a role check here.
router.get('/', validate(listTaskUpdatesQuerySchema, 'query'), taskUpdateController.listUpdates);
router.post('/', validate(createTaskUpdateSchema), taskUpdateController.createUpdate);

module.exports = router;
