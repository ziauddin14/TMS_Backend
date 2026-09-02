const express = require('express');

const uploadsController = require('../controllers/uploads.controller');
const authMiddleware = require('../middleware/auth.middleware');
const { uploadSingleFile, validateUploadedFile } = require('../validators/upload.validator');

const router = express.Router();

// docs/05-apis.md §7 — any authenticated user.
router.post('/', authMiddleware, uploadSingleFile, validateUploadedFile, uploadsController.uploadFile);

module.exports = router;
