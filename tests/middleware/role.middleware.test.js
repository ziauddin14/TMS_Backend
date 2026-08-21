const requireRole = require('../../src/middleware/role.middleware');

describe('role middleware (requireRole)', () => {
  it('allows a matching role through', () => {
    const req = { user: { role: 'admin' } };
    const next = jest.fn();

    requireRole('admin')(req, {}, next);

    expect(next).toHaveBeenCalledWith(); // no error argument
  });

  it('rejects a non-matching role', () => {
    const req = { user: { role: 'user' } };
    const next = jest.fn();

    requireRole('admin')(req, {}, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'FORBIDDEN_ROLE', statusCode: 403 })
    );
  });

  it('rejects when there is no authenticated user on the request at all', () => {
    const req = {};
    const next = jest.fn();

    requireRole('admin')(req, {}, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORBIDDEN_ROLE' }));
  });

  it('is a pure authorization check — does not read or trust any role from the request body', () => {
    const req = { user: { role: 'user' }, body: { role: 'admin' } }; // spoofed body role
    const next = jest.fn();

    requireRole('admin')(req, {}, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORBIDDEN_ROLE' }));
  });
});
