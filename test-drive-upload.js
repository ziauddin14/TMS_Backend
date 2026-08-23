// One-off script to verify the Google Drive service account setup works.
// Run this from inside your `backend` folder: node test-drive-upload.js
// (It reuses backend/node_modules, so googleapis + dotenv must already be installed there.)

require('dotenv').config();
const { google } = require('googleapis');

async function main() {
  const clientEmail = process.env.GOOGLE_DRIVE_CLIENT_EMAIL;
  const privateKey = (process.env.GOOGLE_DRIVE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!clientEmail || !privateKey || !folderId) {
    console.error('❌ Missing one of GOOGLE_DRIVE_CLIENT_EMAIL / GOOGLE_DRIVE_PRIVATE_KEY / GOOGLE_DRIVE_FOLDER_ID in .env');
    process.exit(1);
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

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
        body: 'Hello from Task Management System — this is a test upload to confirm the service account works.',
      },
      fields: 'id, name, webViewLink',
    });

    console.log('✅ SUCCESS! File uploaded:');
    console.log('   File ID:', res.data.id);
    console.log('   Name:', res.data.name);
    console.log('   Link:', res.data.webViewLink);
    console.log('\nAap ye file Drive folder mein jaakar khud bhi dekh sakte hain.');
  } catch (err) {
    console.error('❌ FAILED. Error details below:\n');
    console.error(err.message || err);
    if (err.message && err.message.includes('storageQuotaExceeded')) {
      console.error('\n⚠️  Ye wahi quota wala masla hai jo maine pehle bataya tha — service account ki apni Drive storage 0 hai.');
      console.error('    Solution: agar dawateislami.net Workspace admin access mile to ek "Shared Drive" banayein aur usmein ye service account add karein.');
    }
    process.exit(1);
  }
}

main();
