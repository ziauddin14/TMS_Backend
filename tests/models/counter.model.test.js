const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const Counter = require('../../src/models/Counter');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

function currentYYMM() {
  const now = new Date();
  return `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
}

describe('Counter.getNextCodeNumber', () => {
  it('generates sequential, zero-padded YYMMSS-format code numbers within the same month', async () => {
    const yymm = currentYYMM();

    const c1 = await Counter.getNextCodeNumber();
    const c2 = await Counter.getNextCodeNumber();
    const c3 = await Counter.getNextCodeNumber();

    expect(c1).toBe(`${yymm}01`);
    expect(c2).toBe(`${yymm}02`);
    expect(c3).toBe(`${yymm}03`);
  });

  it('scopes the sequence to a separate counter document per year-month key, leaving other months untouched', async () => {
    const thisMonth = currentYYMM();
    const unrelatedKey = 'taskCode-2001'; // a historical month, never touched by "now"
    await mongoose.connection.collection('counters').insertOne({ _id: unrelatedKey, seq: 5 });

    const next = await Counter.getNextCodeNumber();

    expect(next).toBe(`${thisMonth}01`); // this month's counter starts fresh, unaffected
    const untouched = await mongoose.connection.collection('counters').findOne({ _id: unrelatedKey });
    expect(untouched.seq).toBe(5); // the unrelated month's counter was never incremented
  });

  it('upserts the counter document on first use for a given month', async () => {
    const before = await mongoose.connection.collection('counters').findOne({ _id: `taskCode-${currentYYMM()}` });
    expect(before).toBeNull();

    await Counter.getNextCodeNumber();

    const after = await mongoose.connection.collection('counters').findOne({ _id: `taskCode-${currentYYMM()}` });
    expect(after).not.toBeNull();
    expect(after.seq).toBe(1);
  });

  it('never produces a duplicate code number under 20 concurrent calls (atomic $inc)', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => Counter.getNextCodeNumber())
    );

    expect(new Set(results).size).toBe(20);
    results.forEach((code) => expect(code).toMatch(/^\d{6}$/));
  });
});
