const { Readable } = require('stream');
const { google } = require('googleapis');
const env = require('../config/env');

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getDriveClient() {
  const auth = new google.auth.JWT({
    email: env.GOOGLE_DRIVE_CLIENT_EMAIL,
    // Service-account PEM keys are stored as a single-line env var with literal \n sequences —
    // convert back to real newlines.
    key: env.GOOGLE_DRIVE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

/**
 * docs/06-backend.md §6 step 3: restrict sharing to the Workspace domain if the Drive account
 * supports domain-restricted sharing, falling back to "anyone with the link can view" otherwise.
 * Uses the same GOOGLE_ALLOWED_HD env var as the Auth module (docs/01-architecture.md §5.1 item 7,
 * Phase 3's approved decision) rather than the doc's literal "dawateislami.net" example — domains
 * are never hardcoded anywhere in this codebase. If GOOGLE_ALLOWED_HD is unset, there is no domain
 * to restrict to, so this goes straight to "anyone with the link." Exported separately (alongside
 * sanitizeFileName) for direct unit testing without needing a real Drive client.
 */
async function shareFile(drive, driveFileId, allowedHd) {
  if (allowedHd) {
    try {
      await drive.permissions.create({
        fileId: driveFileId,
        requestBody: { role: 'reader', type: 'domain', domain: allowedHd },
      });
      return;
    } catch (err) {
      // Domain-restricted sharing not supported on this Drive account/plan — fall through.
    }
  }
  await drive.permissions.create({
    fileId: driveFileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });
}

// docs/06-backend.md §6. File-type/size validation happens in validators/upload.validator.js
// before this is ever called (Backend Foundation's "nothing invalid reaches a service" rule).
// _uploaderUserId is part of the documented signature but not otherwise used inside this
// function's own four documented steps — reserved for future audit-logging use.
async function uploadFile(buffer, originalName, mimeType, _uploaderUserId) {
  const drive = getDriveClient();
  const fileName = `${Date.now()}_${sanitizeFileName(originalName)}`;

  const createRes = await drive.files.create({
    requestBody: { name: fileName, parents: [env.GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id, webViewLink',
  });

  const driveFileId = createRes.data.id;
  await shareFile(drive, driveFileId, env.GOOGLE_ALLOWED_HD);

  return {
    driveFileId,
    fileName: originalName,
    url: createRes.data.webViewLink,
  };
}

module.exports = { uploadFile, shareFile, sanitizeFileName };
