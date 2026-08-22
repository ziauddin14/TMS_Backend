const multer = require('multer');
const AppError = require('../utils/AppError');

// docs/05-apis.md §7: max size 100MB (client-confirmed limit).
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

// docs/05-apis.md §7: "PDF, Word, Excel, and common image formats."
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

// Pure translation function, unit-testable without mocking multer's internals or streaming a
// real 100MB+ payload through a request — construct a real multer.MulterError directly instead.
function translateMulterError(err) {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return new AppError('File exceeds the 100MB size limit.', 413, 'FILE_TOO_LARGE');
  }
  return err;
}

// Wraps multer's own middleware so a size-limit violation reaches the centralized error handler
// as the project's standard AppError, not a raw MulterError.
function uploadSingleFile(req, res, next) {
  multerUpload.single('file')(req, res, (err) => {
    if (err) return next(translateMulterError(err));
    next();
  });
}

// Runs after multer has parsed the file (docs/06-backend.md §6: "happens in
// validators/upload.validator.js BEFORE this service is even called") — rejects disallowed types
// before googleDrive.service.uploadFile is ever invoked.
function validateUploadedFile(req, res, next) {
  if (!req.file) {
    return next(
      new AppError('A file is required.', 400, 'VALIDATION_ERROR', [
        { field: 'file', message: 'No file was uploaded.' },
      ])
    );
  }
  if (!ALLOWED_MIME_TYPES.has(req.file.mimetype)) {
    return next(new AppError('Unsupported file type.', 400, 'UNSUPPORTED_FILE_TYPE'));
  }
  next();
}

module.exports = { uploadSingleFile, validateUploadedFile, translateMulterError, ALLOWED_MIME_TYPES };
