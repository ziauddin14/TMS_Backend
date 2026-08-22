// Per-test-file connection helper. The actual in-memory MongoDB process is started once for the
// whole run by tests/setup/globalSetup.js (docs/12-testing.md §1 — mongodb-memory-server); this
// helper just connects Mongoose to that shared instance's URI and cleans up between/after tests.
const mongoose = require('mongoose');

async function connect() {
  await mongoose.connect(process.env.MONGO_TEST_URI);
  // Mongoose's autoIndex background-builds each model's indexes fire-and-forget at connection
  // time. Against the standalone MongoMemoryServer used through Phase 5 this reliably finished
  // before a test file's first insert; against the replica set introduced in Phase 6 (required
  // for transactions — see globalSetup.js) the extra connection/replication overhead made that
  // race newly visible: two pre-existing LookupList uniqueness tests intermittently failed
  // because the unique (listType, value) index hadn't finished building yet. Model.init()
  // resolves once a given model's own index build completes, so awaiting it for every
  // registered model closes this race deterministically for all six models, not just the one
  // that happened to expose it.
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
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
