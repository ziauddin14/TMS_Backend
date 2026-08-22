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

module.exports = { uploadFile };
