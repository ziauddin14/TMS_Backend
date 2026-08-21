const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const userService = require('../../src/services/user.service');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

async function makeUser(overrides = {}) {
  return User.create({
    name: 'User',
    email: `${new mongoose.Types.ObjectId()}@x.com`,
    responsibility: 'X',
    ...overrides,
  });
}

describe('userService.listUsers', () => {
  it('filters by role and isActive, and searches name/email case-insensitively', async () => {
    await makeUser({ name: 'Om Prakash', email: 'om@dawateislami.net', role: 'user' });
    await makeUser({ name: 'Admin Person', email: 'admin@dawateislami.net', role: 'admin' });
    await makeUser({ name: 'Retired', email: 'retired@dawateislami.net', isActive: false });

    const byRole = await userService.listUsers({ role: 'admin' }, { page: 1, limit: 20 });
    expect(byRole.items).toHaveLength(1);
    expect(byRole.items[0].name).toBe('Admin Person');

    const byActive = await userService.listUsers({ isActive: false }, { page: 1, limit: 20 });
    expect(byActive.items).toHaveLength(1);
    expect(byActive.items[0].name).toBe('Retired');

    const bySearch = await userService.listUsers({ search: 'om prak' }, { page: 1, limit: 20 });
    expect(bySearch.items).toHaveLength(1);
    expect(bySearch.items[0].email).toBe('om@dawateislami.net');

    const bySearchEmail = await userService.listUsers({ search: 'DAWATEISLAMI' }, { page: 1, limit: 20 });
    expect(bySearchEmail.items).toHaveLength(3);
  });

  it('treats regex special characters in search as literal text (no ReDoS / broken matching)', async () => {
    await makeUser({ name: 'A.B', email: 'ab@x.com' });
    const res = await userService.listUsers({ search: 'A.B' }, { page: 1, limit: 20 });
    expect(res.items).toHaveLength(1);
  });

  it('paginates with the documented meta shape', async () => {
    for (let i = 0; i < 5; i += 1) await makeUser();

    const res = await userService.listUsers({}, { page: 2, limit: 2 });

    expect(res.items).toHaveLength(2);
    expect(res.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
  });
});

describe('userService.getUserById (Admin or self)', () => {
  it('allows an Admin to fetch any user', async () => {
    const target = await makeUser();
    const admin = { id: 'irrelevant', role: 'admin' };
    const found = await userService.getUserById(admin, target.id);
    expect(found.id).toBe(target.id);
  });

  it('allows a user to fetch their own record', async () => {
    const self = await makeUser();
    const requester = { id: self.id, role: 'user' };
    const found = await userService.getUserById(requester, self.id);
    expect(found.id).toBe(self.id);
  });

  it('rejects a user fetching a different user\'s record with FORBIDDEN_ROLE', async () => {
    const self = await makeUser();
    const other = await makeUser();
    const requester = { id: self.id, role: 'user' };
    await expect(userService.getUserById(requester, other.id)).rejects.toMatchObject({
      code: 'FORBIDDEN_ROLE',
      statusCode: 403,
    });
  });

  it('returns USER_NOT_FOUND_BY_ID for a well-formed but nonexistent id (Admin caller)', async () => {
    const admin = { id: 'irrelevant', role: 'admin' };
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(userService.getUserById(admin, fakeId)).rejects.toMatchObject({
      code: 'USER_NOT_FOUND_BY_ID',
      statusCode: 404,
    });
  });

  it('returns USER_NOT_FOUND_BY_ID rather than a raw CastError for a malformed id (Admin caller)', async () => {
    const admin = { id: 'irrelevant', role: 'admin' };
    await expect(userService.getUserById(admin, 'not-an-object-id')).rejects.toMatchObject({
      code: 'USER_NOT_FOUND_BY_ID',
    });
  });
});

describe('userService.createUser', () => {
  it('creates a user, lowercasing the email, defaulting isActive true', async () => {
    const user = await userService.createUser({
      name: 'Om',
      email: 'Om.Test@DawateIslami.net',
      responsibility: 'X',
      role: 'user',
    });
    expect(user.email).toBe('om.test@dawateislami.net');
    expect(user.isActive).toBe(true);
  });

  it('rejects a duplicate email with DUPLICATE_EMAIL (409)', async () => {
    await makeUser({ email: 'dup@dawateislami.net' });
    await expect(
      userService.createUser({ name: 'X', email: 'DUP@dawateislami.net', responsibility: 'X', role: 'user' })
    ).rejects.toMatchObject({ code: 'DUPLICATE_EMAIL', statusCode: 409 });
  });
});

describe('userService.updateUser', () => {
  it('updates name, responsibility, role, isActive', async () => {
    const user = await makeUser({ role: 'user' });
    const updated = await userService.updateUser(user.id, {
      name: 'New Name',
      responsibility: 'New Role',
      role: 'admin',
      isActive: false,
    });
    expect(updated).toMatchObject({
      name: 'New Name',
      responsibility: 'New Role',
      role: 'admin',
      isActive: false,
    });
  });

  it('never changes email even if present in the patch object (defense-in-depth allowlist)', async () => {
    const user = await makeUser({ email: 'original@dawateislami.net' });
    const updated = await userService.updateUser(user.id, { email: 'changed@dawateislami.net' });
    expect(updated.email).toBe('original@dawateislami.net');
  });

  it('returns USER_NOT_FOUND_BY_ID for a nonexistent id', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(userService.updateUser(fakeId, { name: 'X' })).rejects.toMatchObject({
      code: 'USER_NOT_FOUND_BY_ID',
      statusCode: 404,
    });
  });
});
