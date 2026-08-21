const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const LookupList = require('../../src/models/LookupList');
const lookupListService = require('../../src/services/lookupList.service');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

describe('lookupListService.listActive', () => {
  it('returns only active values, sorted by sortOrder', async () => {
    await LookupList.create({ listType: 'responsibility', value: 'C', sortOrder: 2 });
    await LookupList.create({ listType: 'responsibility', value: 'A', sortOrder: 0 });
    await LookupList.create({ listType: 'responsibility', value: 'B', sortOrder: 1, isActive: false });

    const result = await lookupListService.listActive('responsibility');

    expect(result.map((r) => r.value)).toEqual(['A', 'C']);
  });
});

describe('lookupListService.createValue', () => {
  it('creates a value with the model default sortOrder when omitted', async () => {
    const entry = await lookupListService.createValue({ listType: 'responsibility', value: 'X' });
    expect(entry.sortOrder).toBe(0);
    expect(entry.isActive).toBe(true);
  });

  it('rejects a duplicate (listType, value) pair with DUPLICATE_LOOKUP_VALUE (409)', async () => {
    await lookupListService.createValue({ listType: 'responsibility', value: 'Donation Box Incharge' });
    await expect(
      lookupListService.createValue({ listType: 'responsibility', value: 'Donation Box Incharge' })
    ).rejects.toMatchObject({ code: 'DUPLICATE_LOOKUP_VALUE', statusCode: 409 });
  });

  it('is race-condition-safe: firing two concurrent creates for the same value, exactly one succeeds', async () => {
    const attempt = () => lookupListService.createValue({ listType: 'responsibility', value: 'Concurrent Value' });

    const results = await Promise.allSettled([attempt(), attempt()]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'DUPLICATE_LOOKUP_VALUE' });

    const count = await LookupList.countDocuments({ listType: 'responsibility', value: 'Concurrent Value' });
    expect(count).toBe(1);
  });
});

describe('lookupListService.updateValue', () => {
  it('updates value, sortOrder, isActive', async () => {
    const entry = await LookupList.create({ listType: 'responsibility', value: 'Old', sortOrder: 5 });
    const updated = await lookupListService.updateValue(entry.id, {
      value: 'New',
      sortOrder: 9,
      isActive: false,
    });
    expect(updated).toMatchObject({ value: 'New', sortOrder: 9, isActive: false });
  });

  it('returns LOOKUP_NOT_FOUND for a nonexistent id', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(lookupListService.updateValue(fakeId, { isActive: false })).rejects.toMatchObject({
      code: 'LOOKUP_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('returns LOOKUP_NOT_FOUND rather than a raw CastError for a malformed id', async () => {
    await expect(lookupListService.updateValue('not-an-id', { isActive: false })).rejects.toMatchObject({
      code: 'LOOKUP_NOT_FOUND',
    });
  });

  it('rejects a rename that collides with another existing value, with DUPLICATE_LOOKUP_VALUE', async () => {
    await LookupList.create({ listType: 'responsibility', value: 'Taken' });
    const entry = await LookupList.create({ listType: 'responsibility', value: 'Free' });

    await expect(lookupListService.updateValue(entry.id, { value: 'Taken' })).rejects.toMatchObject({
      code: 'DUPLICATE_LOOKUP_VALUE',
    });
  });

  it('retiring a value (isActive:false) does not delete it or affect its stored text', async () => {
    const entry = await LookupList.create({ listType: 'responsibility', value: 'Retire Me' });
    await lookupListService.updateValue(entry.id, { isActive: false });

    const stillThere = await LookupList.findById(entry.id);
    expect(stillThere).not.toBeNull();
    expect(stillThere.value).toBe('Retire Me');
    expect(stillThere.isActive).toBe(false);
  });
});
