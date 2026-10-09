/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  setupFiles: ['<rootDir>/tests/setupEnv.ts'],
  globalSetup: '<rootDir>/tests/globalSetup.ts',
  // Tests share one database schema; run files serially.
  maxWorkers: 1,
  testTimeout: 20000,
  // A hung request (e.g. an unhandled async error) must fail the run, not stall it.
  forceExit: true,
}
