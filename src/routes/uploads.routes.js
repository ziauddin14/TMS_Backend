const express = require('express');

const uploadsController = require('../controllers/uploads.controller');
const authMiddleware = require('../middleware/auth.middleware');
const { uploadSingleFile, validateUploadedFile } = require('../validators/upload.validator');

const router = express.Router();

// docs/05-apis.md §7 — any authenticated user.
router.post('/', authMiddleware, uploadSingleFile, validateUploadedFile, uploadsController.uploadFile);

// Diagnostic endpoint for Google OAuth token acquisition
router.get('/diagnostic/google-auth', authMiddleware, uploadsController.testGoogleAuth);

module.exports = router;
