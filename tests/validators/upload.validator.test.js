const multer = require('multer');
const {
  translateMulterError,
  validateUploadedFile,
} = require('../../src/validators/upload.validator');

describe('translateMulterError', () => {
  it('translates a real LIMIT_FILE_SIZE MulterError into FILE_TOO_LARGE (413)', () => {
    const err = new multer.MulterError('LIMIT_FILE_SIZE');
    const translated = translateMulterError(err);
    expect(translated).toMatchObject({ code: 'FILE_TOO_LARGE', statusCode: 413 });
  });

  it('passes through an unrelated error unchanged', () => {
    const err = new Error('some other multer error');
    expect(translateMulterError(err)).toBe(err);
  });

  it('passes through a different MulterError code unchanged', () => {
    const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE');
    expect(translateMulterError(err)).toBe(err);
  });
});

describe('validateUploadedFile', () => {
  it('rejects a request with no file, VALIDATION_ERROR', () => {
    const next = jest.fn();
    validateUploadedFile({ file: undefined }, {}, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }));
  });

  it('rejects a disallowed mimetype, UNSUPPORTED_FILE_TYPE', () => {
    const next = jest.fn();
    validateUploadedFile({ file: { mimetype: 'application/x-msdownload' } }, {}, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'UNSUPPORTED_FILE_TYPE', statusCode: 400 })
    );
  });

  it.each(['application/pdf', 'image/jpeg', 'image/png', 'application/vnd.ms-excel'])(
    'allows an allowed mimetype through (%s)',
    (mimetype) => {
      const next = jest.fn();
      validateUploadedFile({ file: { mimetype } }, {}, next);
      expect(next).toHaveBeenCalledWith();
    }
  );
});
