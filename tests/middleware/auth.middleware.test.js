const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const authMiddleware = require('../../src/middleware/auth.middleware');
const env = require('../../src/config/env');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

async function run(req) {
  const res = mockRes();
  const next = jest.fn();
  await authMiddleware(req, res, next);
  return { res, next };
}

describe('auth middleware', () => {
  it('attaches req.user for a valid token belonging to an active user', async () => {
    const user = await User.create({ name: 'A', email: 'a@x.com', responsibility: 'X' });
    const token = jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN,
    });
    const req = { headers: { authorization: `Bearer ${token}` } };

    const { next } = await run(req);

    expect(next).toHaveBeenCalledWith(); // called with no error argument
    expect(req.user).toMatchObject({
      id: user.id,
      role: 'user',
      name: 'A',
      email: 'a@x.com',
    });
  });

  it('rejects a missing Authorization header', async () => {
    const { next } = await run({ headers: {} });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED', statusCode: 401 }));
  });

  it('rejects a header without the Bearer scheme', async () => {
    const { next } = await run({ headers: { authorization: 'Basic somevalue' } });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('rejects a malformed JWT', async () => {
    const { next } = await run({ headers: { authorization: 'Bearer not-a-real-jwt' } });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('rejects an expired JWT', async () => {
    const user = await User.create({ name: 'A', email: 'expired@x.com', responsibility: 'X' });
    const token = jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: -10 });
    const { next } = await run({ headers: { authorization: `Bearer ${token}` } });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('rejects a token signed with the wrong secret — cannot be forged', async () => {
    const user = await User.create({ name: 'A', email: 'forge@x.com', responsibility: 'X' });
    const token = jwt.sign({ sub: user.id, role: 'admin' }, 'a-completely-different-secret', {
      expiresIn: '7d',
    });
    const { next } = await run({ headers: { authorization: `Bearer ${token}` } });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('rejects a token whose user no longer exists in the database', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const token = jwt.sign({ sub: fakeId.toString(), role: 'user' }, env.JWT_SECRET, {
      expiresIn: '7d',
    });
    const { next } = await run({ headers: { authorization: `Bearer ${token}` } });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('rejects a token for a user who has since been deactivated', async () => {
    const user = await User.create({ name: 'A', email: 'deact@x.com', responsibility: 'X' });
    const token = jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: '7d' });
    user.isActive = false;
    await user.save();

    const { next } = await run({ headers: { authorization: `Bearer ${token}` } });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('a client cannot escalate role by tampering with the token payload without the secret', async () => {
    const user = await User.create({
      name: 'A',
      email: 'tamper@x.com',
      responsibility: 'X',
      role: 'user',
    });
    const token = jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: '7d' });
    const [headerB64, payloadB64, signature] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    payload.role = 'admin'; // attempted privilege escalation
    const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const tamperedToken = `${headerB64}.${tamperedPayloadB64}.${signature}`;

    const { next } = await run({ headers: { authorization: `Bearer ${tamperedToken}` } });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('never exposes the JWT secret in the rejection error', async () => {
    const { next } = await run({ headers: { authorization: 'Bearer garbage' } });
    const err = next.mock.calls[0][0];
    expect(JSON.stringify({ message: err.message, code: err.code })).not.toContain(env.JWT_SECRET);
  });
});
