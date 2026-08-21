module.exports = {
  testEnvironment: 'node',
  clearMocks: true,
  verbose: true,
  testMatch: ['**/tests/**/*.test.js'],
  globalSetup: '<rootDir>/tests/setup/globalSetup.js',
  globalTeardown: '<rootDir>/tests/setup/globalTeardown.js',
  // Per-test timeout for normal assertions. Mongo startup itself happens once in globalSetup,
  // which Jest does not bound by testTimeout, so this can stay modest.
  testTimeout: 30000,
};
