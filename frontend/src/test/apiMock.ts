// Route-based stand-in for src/lib/api in component tests. Use with:
//   vi.mock('<relative path>/lib/api', () => import('<relative path>/test/apiMock'))
import { vi } from 'vitest'

type Handler = (body?: unknown) => unknown
export const routes = new Map<string, Handler>()

function call(method: string, url: string, body?: unknown) {
  const handler = routes.get(`${method} ${url}`)
  if (!handler) return Promise.reject(new Error(`no mock for ${method} ${url}`))
  try {
    const result = handler(body)
    return result instanceof Error ? Promise.reject(result) : Promise.resolve({ data: result })
  } catch (e) {
    return Promise.reject(e)
  }
}

export const api = {
  get: vi.fn((url: string) => call('GET', url)),
  put: vi.fn((url: string, body?: unknown) => call('PUT', url, body)),
  post: vi.fn((url: string, body?: unknown) => call('POST', url, body)),
}
