const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const LookupList = require('../../src/models/LookupList');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

describe('LookupList model', () => {
  it('creates a valid value with documented defaults', async () => {
    const entry = await LookupList.create({
      listType: 'responsibility',
      value: 'Donation Box Incharge',
    });

    expect(entry.isActive).toBe(true);
    expect(entry.sortOrder).toBe(0);
  });

  it('requires listType and value', async () => {
    await expect(LookupList.create({})).rejects.toThrow();
  });

  it('rejects a listType outside the documented enum', async () => {
    await expect(
      LookupList.create({ listType: 'zimmedar', value: 'X' })
    ).rejects.toThrow();
  });

  it('enforces uniqueness on (listType, value)', async () => {
    await LookupList.create({ listType: 'responsibility', value: 'Donation Box Incharge' });

    await expect(
      LookupList.create({ listType: 'responsibility', value: 'Donation Box Incharge' })
    ).rejects.toThrow(/E11000/);
  });

  it('lets a value be retired via isActive instead of deleted', async () => {
    const entry = await LookupList.create({ listType: 'responsibility', value: 'Old Role' });
    entry.isActive = false;
    await entry.save();

    const found = await LookupList.findById(entry._id);
    expect(found.isActive).toBe(false);
  });
});
