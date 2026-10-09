// Tests run against a dedicated Postgres schema so they never touch dev data.
// Override with TEST_DATABASE_URL (CI does).
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://verdict_user:verdict_dev_password@localhost:5432/verdict_db?schema=test'
