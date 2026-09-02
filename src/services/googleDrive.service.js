const { Readable } = require('stream');
const { google } = require('googleapis');
const env = require('../config/env');

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// A service-account (JWT) client has no Drive storage quota of its own — uploading into a folder
// it doesn't own fails with 403 "Service Accounts do not have storage quota." Authenticating as a
// real, dedicated Google account instead (via a one-time-obtained OAuth2 refresh token) gives the
// upload somewhere to actually land, since that account's own Drive storage backs it.
function getDriveClient() {
  const clientId = env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_DRIVE_REFRESH_TOKEN;

  console.log('[DEBUG] Google Drive OAuth runtime check:', {
    clientIdPresent: Boolean(clientId),
    clientIdLength: clientId?.length,
    clientIdStart: clientId?.slice(0, 12),
    clientIdEnd: clientId?.slice(-12),

    clientSecretPresent: Boolean(clientSecret),
    clientSecretLength: clientSecret?.length,
    clientSecretStart: clientSecret?.slice(0, 10),
    clientSecretEnd: clientSecret?.slice(-6),

    refreshTokenPresent: Boolean(refreshToken),
    refreshTokenLength: refreshToken?.length,
    refreshTokenStart: refreshToken?.slice(0, 10),
    refreshTokenEnd: refreshToken?.slice(-6),

    folderIdPresent: Boolean(env.GOOGLE_DRIVE_FOLDER_ID),
    folderIdLength: env.GOOGLE_DRIVE_FOLDER_ID?.length,
  });

  const auth = new google.auth.OAuth2(
    clientId,
    clientSecret
  );

  auth.setCredentials({
    refresh_token: refreshToken
  });

  console.log(
    '[DEBUG] Google Drive auth client type:',
    auth.constructor.name
  );

  return google.drive({
    version: 'v3',
    auth
  });
}

async function testGoogleDriveAuth() {
  const auth = new google.auth.OAuth2(
    env.GOOGLE_DRIVE_CLIENT_ID,
    env.GOOGLE_DRIVE_CLIENT_SECRET
  );

  auth.setCredentials({
    refresh_token: env.GOOGLE_DRIVE_REFRESH_TOKEN
  });

  try {
    const accessTokenResponse = await auth.getAccessToken();
    console.log(
      '[DEBUG] Google OAuth token acquisition successful:',
      Boolean(accessTokenResponse?.token)
    );
    return { success: true };
  } catch (error) {
    console.error(
      '[DEBUG] Google OAuth token acquisition failed:',
      {
        code: error?.code,
        status: error?.response?.status,
        error: error?.response?.data?.error,
        errorDescription: error?.response?.data?.error_description
      }
    );
    return {
      success: false,
      code: error?.code,
      status: error?.response?.status,
      error: error?.response?.data?.error,
      errorDescription: error?.response?.data?.error_description
    };
  }
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

module.exports = { uploadFile, shareFile, sanitizeFileName, testGoogleDriveAuth };
