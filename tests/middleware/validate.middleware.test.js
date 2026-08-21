const { z } = require('zod');
const validate = require('../../src/middleware/validate.middleware');

describe('validate middleware', () => {
  const schema = z.object({ idToken: z.string().min(1) });

  it('calls next() and normalizes req.body on valid input, stripping unknown fields', () => {
    const req = { body: { idToken: 'abc', role: 'admin' } }; // role is not part of the schema
    const next = jest.fn();

    validate(schema)(req, {}, next);

    expect(next).toHaveBeenCalledWith(); // no error
    expect(req.body).toEqual({ idToken: 'abc' });
  });

  it('calls next(err) with VALIDATION_ERROR and field-level details on invalid input', () => {
    const req = { body: {} };
    const next = jest.fn();

    validate(schema)(req, {}, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: expect.arrayContaining([expect.objectContaining({ field: 'idToken' })]),
      })
    );
  });
});
