const googleDriveService = require('../services/googleDrive.service');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

// POST /uploads — docs/05-apis.md §7
const uploadFile = asyncHandler(async (req, res) => {
  const result = await googleDriveService.uploadFile(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    req.user.id
  );
  sendSuccess(res, { data: result });
});

const testGoogleAuth = asyncHandler(async (req, res) => {
  const result = await googleDriveService.testGoogleDriveAuth();
  if (result.success) {
    sendSuccess(res, { data: { googleOAuth: 'working' } });
  } else {
    // We send a 500 or just success but with failed data. 
    // The instructions say it must return something safe like { success: false, data: { googleOAuth: 'failed', code: 401, error: 'invalid_client', errorDescription: 'The OAuth client was not found.' } }
    // sendSuccess formats it with { success: true } though. Let's construct the raw response if it failed, or use standard api response.
    res.status(500).json({
      success: false,
      data: {
        googleOAuth: 'failed',
        code: result.code,
        error: result.error,
        errorDescription: result.errorDescription
      }
    });
  }
});

module.exports = { uploadFile, testGoogleAuth };
