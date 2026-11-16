import { describe, expect, it } from 'vitest'
import { devServerPort } from './devServerPort'

describe('Vite dev-server port (same FRONTEND_PORT the backend uses for Codespaces links)', () => {
  it('shell, then backend/.env, then 5173', () => {
    expect(devServerPort({}, {})).toBe(5173)
    expect(devServerPort({}, { FRONTEND_PORT: '4000' })).toBe(4000)
    expect(devServerPort({ FRONTEND_PORT: '4100' }, { FRONTEND_PORT: '4000' })).toBe(4100)
    expect(devServerPort({ FRONTEND_PORT: 'nope' }, { FRONTEND_PORT: '4000' })).toBe(4000)
    expect(devServerPort({ FRONTEND_PORT: '70000' }, {})).toBe(5173)
  })
})
