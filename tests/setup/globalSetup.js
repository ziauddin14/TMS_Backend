// Starts exactly ONE in-memory MongoDB instance for the entire test run (not one per test file),
// so the mongod binary is downloaded/started once regardless of how many model test files exist.
// Standard Jest pattern (same approach used by @shelf/jest-mongodb): globalSetup and
// globalTeardown share the same top-level process/global scope, distinct from per-file workers.
//
// Phase 6 upgrade: a single-member REPLICA SET (MongoMemoryReplSet), not a standalone
// MongoMemoryServer. taskUpdate.service.js's createUpdate() uses a real multi-document ACID
// transaction (docs/06-backend.md §5 step 3), and MongoDB flatly refuses session.startTransaction()
// on a standalone deployment ("Transaction numbers are only allowed on a replica set member or
// mongos") — so standalone mode cannot support this phase's tests at all, not just suboptimally.
// wiredTiger is required explicitly because replica sets need a storage engine that supports it
// (mongodb-memory-server's standalone default, ephemeralForTest, does not).
const { MongoMemoryReplSet } = require('mongodb-memory-server');

module.exports = async function globalSetup() {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    // Pinned to an older, much smaller server build (~250MB vs ~570MB+ for 8.x) purely to
    // reduce the odds of the download being interrupted on an unreliable connection. This is a
    // test-tooling choice only — it has no bearing on the documented production database, which
    // remains MongoDB Atlas regardless of local test-binary version (docs/01-architecture.md §0).
    // Transactions are fully supported on this version (require only 4.0+).
    binary: { version: '6.0.14' },
  });
  await replSet.waitUntilRunning();
  global.__MONGOD__ = replSet;
  process.env.MONGO_TEST_URI = replSet.getUri();
};
