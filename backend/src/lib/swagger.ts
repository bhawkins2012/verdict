import { Express } from 'express'
import swaggerUi from 'swagger-ui-express'

const spec = {
  openapi: '3.0.0',
  info: {
    title: 'Verdict API',
    version: '1.0.0',
    description: 'Longitudinal review platform API',
  },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
    }
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register a new user',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'username', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  username: { type: 'string', minLength: 3 },
                  password: { type: 'string', minLength: 8 },
                  displayName: { type: 'string' },
                }
              }
            }
          }
        },
        responses: { '201': { description: 'User created' }, '409': { description: 'Email/username taken' } }
      }
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Login',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string' },
                  password: { type: 'string' },
                }
              }
            }
          }
        },
        responses: { '200': { description: 'Login successful' }, '401': { description: 'Invalid credentials' } }
      }
    },
    '/products': {
      get: {
        tags: ['Products'],
        summary: 'Search and browse products',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { '200': { description: 'Product list with pagination' } }
      }
    },
    '/reviews': {
      post: {
        tags: ['Reviews'],
        summary: 'Submit a review',
        security: [{ bearerAuth: [] }],
        responses: { '201': { description: 'Review created' } }
      }
    },
    '/reviews/threads': {
      get: {
        tags: ['Reviews'],
        summary: 'Get all review threads for current user',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Thread list' } }
      }
    },
    '/reviews/product/{productId}/stats': {
      get: {
        tags: ['Reviews'],
        summary: 'Get survivorship curve and stats for a product',
        parameters: [{ name: 'productId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Product stats including survivorship curve' } }
      }
    },
    '/recommendations': {
      get: {
        tags: ['Recommendations'],
        summary: 'Get personalized recommendations',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } },
          { name: 'category', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Recommendation list with scores and reasons' } }
      }
    },
  }
}

export function setupSwagger(app: Express) {
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec))
}
