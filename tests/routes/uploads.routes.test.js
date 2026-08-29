const mockFilesCreate = jest.fn();
const mockPermissionsCreate = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn() })),
    },
    drive: jest.fn().mockImplementation(() => ({
      files: { create: mockFilesCreate },
      permissions: { create: mockPermissionsCreate },
    })),
  },
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');

beforeAll(async () => connect());
afterEach(async () => {
  await clearDatabase();
  mockFilesCreate.mockReset();
  mockPermissionsCreate.mockReset();
});
afterAll(async () => closeDatabase());

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
}
async function makeUser(overrides = {}) {
  return User.create({
    name: 'User',
    email: `user${new mongoose.Types.ObjectId()}@x.com`,
    responsibility: 'X',
    role: 'user',
    ...overrides,
  });
}

describe('POST /api/v1/uploads', () => {
  it('uploads a valid file and returns the documented shape', async () => {
    const user = await makeUser();
    mockFilesCreate.mockResolvedValue({ data: { id: 'drive-1', webViewLink: 'https://drive.google.com/file/1' } });
    mockPermissionsCreate.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/uploads')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), {
        filename: 'receipt.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { driveFileId: 'drive-1', fileName: 'receipt.pdf', url: 'https://drive.google.com/file/1' },
    });
    expect(mockFilesCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app)
      .post('/api/v1/uploads')
      .attach('file', Buffer.from('x'), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(401);
    expect(mockFilesCreate).not.toHaveBeenCalled();
  });

  it('rejects an unsupported file type before ever calling Google Drive', async () => {
    const user = await makeUser();

    const res = await request(app)
      .post('/api/v1/uploads')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .attach('file', Buffer.from('MZ fake exe'), { filename: 'virus.exe', contentType: 'application/x-msdownload' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect(mockFilesCreate).not.toHaveBeenCalled();
  });

  it('rejects a request with no file attached', async () => {
    const user = await makeUser();
    const res = await request(app).post('/api/v1/uploads').set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(mockFilesCreate).not.toHaveBeenCalled();
  });
});
