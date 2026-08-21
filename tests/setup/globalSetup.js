// Starts exactly ONE in-memory MongoDB instance for the entire test run (not one per test file),
// so the mongod binary is downloaded/started once regardless of how many model test files exist.
// Standard Jest pattern (same approach used by @shelf/jest-mongodb): globalSetup and
// globalTeardown share the same top-level process/global scope, distinct from per-file workers.
const { MongoMemoryServer } = require('mongodb-memory-server');

module.exports = async function globalSetup() {
  const mongod = await MongoMemoryServer.create({
    // Pinned to an older, much smaller server build (~250MB vs ~570MB+ for 8.x) purely to
    // reduce the odds of the download being interrupted on an unreliable connection. This is a
    // test-tooling choice only — it has no bearing on the documented production database, which
    // remains MongoDB Atlas regardless of local test-binary version (docs/01-architecture.md §0).
    // All Phase 2 schema/index/atomic-operator behavior under test is stable across this range.
    binary: { version: '6.0.14' },
  });
  global.__MONGOD__ = mongod;
  process.env.MONGO_TEST_URI = mongod.getUri();
};
