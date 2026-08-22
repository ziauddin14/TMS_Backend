const mockFilesCreate = jest.fn();
const mockPermissionsCreate = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    auth: { JWT: jest.fn().mockImplementation(() => ({})) },
    drive: jest.fn().mockImplementation(() => ({
      files: { create: mockFilesCreate },
      permissions: { create: mockPermissionsCreate },
    })),
  },
}));

const { uploadFile, shareFile, sanitizeFileName } = require('../../src/services/googleDrive.service');

beforeEach(() => {
  mockFilesCreate.mockReset();
  mockPermissionsCreate.mockReset();
});

describe('sanitizeFileName', () => {
  it('replaces characters outside a safe allowlist', () => {
    expect(sanitizeFileName('my report (final) #2.pdf')).toBe('my_report__final___2.pdf');
  });

  it('leaves an already-safe name untouched', () => {
    expect(sanitizeFileName('report_v2-final.pdf')).toBe('report_v2-final.pdf');
  });
});

describe('uploadFile (docs/06-backend.md §6)', () => {
  it('builds a collision-safe filename, uploads, and returns the documented shape', async () => {
    mockFilesCreate.mockResolvedValue({ data: { id: 'drive-id-123', webViewLink: 'https://drive.google.com/file/123' } });
    mockPermissionsCreate.mockResolvedValue({});

    const before = Date.now();
    const result = await uploadFile(Buffer.from('hello'), 'receipt (1).jpg', 'image/jpeg', 'user-1');
    const after = Date.now();

    expect(mockFilesCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockFilesCreate.mock.calls[0][0];
    const [timestampPart, ...rest] = callArgs.requestBody.name.split('_');
    expect(Number(timestampPart)).toBeGreaterThanOrEqual(before);
    expect(Number(timestampPart)).toBeLessThanOrEqual(after);
    expect(rest.join('_')).toBe('receipt__1_.jpg');
    expect(callArgs.requestBody.parents).toEqual(['test-drive-folder-id']);
    expect(callArgs.media.mimeType).toBe('image/jpeg');

    // Return shape uses the ORIGINAL filename, not the sanitized storage name.
    expect(result).toEqual({
      driveFileId: 'drive-id-123',
      fileName: 'receipt (1).jpg',
      url: 'https://drive.google.com/file/123',
    });
  });

  it('shares the file after creating it', async () => {
    mockFilesCreate.mockResolvedValue({ data: { id: 'drive-id-456', webViewLink: 'https://drive.google.com/file/456' } });
    mockPermissionsCreate.mockResolvedValue({});

    await uploadFile(Buffer.from('x'), 'x.pdf', 'application/pdf', 'user-1');

    expect(mockPermissionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'drive-id-456' })
    );
  });
});

describe('shareFile (domain-restricted with fallback, docs/06-backend.md §6 step 3)', () => {
  it('shares "anyone with the link" when no allowedHd is configured', async () => {
    mockPermissionsCreate.mockResolvedValue({});
    const drive = { permissions: { create: mockPermissionsCreate } };

    await shareFile(drive, 'file-1', '');

    expect(mockPermissionsCreate).toHaveBeenCalledTimes(1);
    expect(mockPermissionsCreate).toHaveBeenCalledWith({
      fileId: 'file-1',
      requestBody: { role: 'reader', type: 'anyone' },
    });
  });

  it('restricts to the configured domain when allowedHd is set and supported', async () => {
    mockPermissionsCreate.mockResolvedValue({});
    const drive = { permissions: { create: mockPermissionsCreate } };

    await shareFile(drive, 'file-2', 'dawateislami.net');

    expect(mockPermissionsCreate).toHaveBeenCalledTimes(1);
    expect(mockPermissionsCreate).toHaveBeenCalledWith({
      fileId: 'file-2',
      requestBody: { role: 'reader', type: 'domain', domain: 'dawateislami.net' },
    });
  });

  it('falls back to "anyone with the link" if domain-restricted sharing is rejected', async () => {
    mockPermissionsCreate
      .mockRejectedValueOnce(new Error('domain sharing not supported on this plan'))
      .mockResolvedValueOnce({});
    const drive = { permissions: { create: mockPermissionsCreate } };

    await shareFile(drive, 'file-3', 'dawateislami.net');

    expect(mockPermissionsCreate).toHaveBeenCalledTimes(2);
    expect(mockPermissionsCreate).toHaveBeenNthCalledWith(1, {
      fileId: 'file-3',
      requestBody: { role: 'reader', type: 'domain', domain: 'dawateislami.net' },
    });
    expect(mockPermissionsCreate).toHaveBeenNthCalledWith(2, {
      fileId: 'file-3',
      requestBody: { role: 'reader', type: 'anyone' },
    });
  });
});
