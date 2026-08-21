// Per-test-file connection helper. The actual in-memory MongoDB process is started once for the
// whole run by tests/setup/globalSetup.js (docs/12-testing.md §1 — mongodb-memory-server); this
// helper just connects Mongoose to that shared instance's URI and cleans up between/after tests.
const mongoose = require('mongoose');

async function connect() {
  await mongoose.connect(process.env.MONGO_TEST_URI);
}

async function closeDatabase() {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
}

async function clearDatabase() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}

module.exports = { connect, closeDatabase, clearDatabase };
