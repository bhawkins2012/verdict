import { TEST_DATABASE_URL } from './testEnv'

process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = TEST_DATABASE_URL
process.env.JWT_SECRET = 'test-access-secret-at-least-32-characters-long'
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-32-characters-long'
process.env.JWT_EXPIRES_IN = '15m'
process.env.JWT_REFRESH_EXPIRES_IN = '30d'
process.env.ML_SERVICE_URL = 'http://ml.test'
process.env.LOG_LEVEL = 'error'
