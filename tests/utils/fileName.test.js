const { repairFileName } = require('../../src/utils/fileName');

// An attachment name stored garbled (UTF-8 read as Latin-1 by multer's default) is shown repaired;
// every other name — and a missing one — comes back exactly as it is.
const garble = (name) => Buffer.from(name, 'utf8').toString('latin1');

describe('repairFileName', () => {
  it('repairs a garbled Urdu name', () => {
    const name = 'اجلاس کی رپورٹ اکتوبر 2026.pdf';
    expect(garble(name)).not.toBe(name);
    expect(repairFileName(garble(name))).toBe(name);
  });

  it.each([
    ['a correct Urdu name', 'اجلاس کی رپورٹ.pdf'],
    ['an English name', 'receipt (1).pdf'],
    ['a real Latin-1 name, not valid UTF-8 as bytes', 'café.pdf'],
    ['Latin-1 bytes that are not valid UTF-8', 'Ã(.pdf'],
    ['an empty name', ''],
  ])('leaves %s as it is', (_label, name) => {
    expect(repairFileName(name)).toBe(name);
  });

  it('leaves a missing name as it is', () => {
    expect(repairFileName(undefined)).toBeUndefined();
    expect(repairFileName(null)).toBeNull();
  });
});
