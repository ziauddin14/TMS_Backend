// One-off script to verify the Google Drive OAuth2 (dedicated-account) setup works.
// Run this from inside your `backend` folder: node test-drive-upload.js
// (It reuses backend/node_modules, so googleapis + dotenv must already be installed there.)

require('dotenv').config();
const { google } = require('googleapis');

async function main() {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!clientId || !clientSecret || !refreshToken || !folderId) {
    console.error(
      '❌ Missing one of GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET / GOOGLE_DRIVE_REFRESH_TOKEN / GOOGLE_DRIVE_FOLDER_ID in .env'
    );
    process.exit(1);
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  console.log('[DEBUG] Google Drive auth client type:', auth.constructor.name);

  const drive = google.drive({ version: 'v3', auth });

  console.log('Uploading test file to folder:', folderId, '...');

  try {
    const res = await drive.files.create({
      requestBody: {
        name: `test-upload-${Date.now()}.txt`,
        parents: [folderId],
      },
      media: {
        mimeType: 'text/plain',
        body: 'Hello from Task Management System — this is a test upload to confirm the OAuth2 (dedicated-account) Drive setup works.',
      },
      fields: 'id, name, webViewLink',
    });

    console.log('✅ SUCCESS! File uploaded:');
    console.log('   File ID:', res.data.id);
    console.log('   Name:', res.data.name);
    console.log('   Link:', res.data.webViewLink);
  } catch (err) {
    console.error('❌ FAILED. Error details below:\n');
    console.error(err.message || err);
    if (err.message && err.message.includes('storage quota')) {
      console.error(
        '\n⚠️  This is the service-account quota error — it means GOOGLE_DRIVE_CLIENT_ID/SECRET/REFRESH_TOKEN' +
          ' are not actually being used, or the refresh token belongs to a service account rather than a real,' +
          ' dedicated Google account. Re-check the values set in .env / Render against a fresh OAuth consent flow.'
      );
    }
    process.exit(1);
  }
}

main();
