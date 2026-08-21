const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

describe('User model', () => {
  it('creates a valid user with documented defaults', async () => {
    const user = await User.create({
      name: 'Om Prakash',
      email: 'Om.Donationbox@dawateislami.net',
      responsibility: 'Donation Box Incharge',
    });

    expect(user.role).toBe('user'); // default
    expect(user.isActive).toBe(true); // default
    expect(user.email).toBe('om.donationbox@dawateislami.net'); // lowercased
    expect(user.toJSON()).toHaveProperty('id');
    expect(user.toJSON()).not.toHaveProperty('_id');
    expect(user.toJSON()).not.toHaveProperty('__v');
  });

  it('requires name, email, and responsibility', async () => {
    await expect(User.create({})).rejects.toThrow();
  });

  it('rejects an invalid email format', async () => {
    await expect(
      User.create({ name: 'Test', email: 'not-an-email', responsibility: 'X' })
    ).rejects.toThrow(/Invalid email format/);
  });

  it('rejects a role outside the documented enum', async () => {
    await expect(
      User.create({
        name: 'Test',
        email: 'test@example.com',
        responsibility: 'X',
        role: 'superadmin',
      })
    ).rejects.toThrow();
  });

  it('enforces email uniqueness at the database level', async () => {
    await User.create({
      name: 'First',
      email: 'duplicate@dawateislami.net',
      responsibility: 'X',
    });

    await expect(
      User.create({
        name: 'Second',
        email: 'duplicate@dawateislami.net',
        responsibility: 'Y',
      })
    ).rejects.toThrow(/E11000/);
  });

  it('allows deactivating a user via isActive rather than deleting the document', async () => {
    const user = await User.create({
      name: 'Test',
      email: 'deactivate@example.com',
      responsibility: 'X',
    });

    user.isActive = false;
    await user.save();

    const found = await User.findById(user._id);
    expect(found).not.toBeNull();
    expect(found.isActive).toBe(false);
  });
});
