// .devcontainer/start.sh must always leave a final status in .devcontainer/last-start.log (the shell hook
// and postAttachCommand show it), including when the frontend URL cannot be resolved.
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const repo = path.join(__dirname, '..', '..')
const log = path.join(repo, '.devcontainer', 'last-start.log')

describe('.devcontainer/start.sh summary', () => {
  it('writes PROBLEMS (not RUNNING) when npx and Docker are unavailable, with the frontend-URL problem listed', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'start-home-'))
    const stubs = fs.mkdtempSync(path.join(os.tmpdir(), 'start-stubs-'))
    // Stubs: no real Docker (never start containers on a CI runner) and an npx that always fails.
    for (const tool of ['docker', 'npx']) fs.writeFileSync(path.join(stubs, tool), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const created = ['backend/.env', 'frontend/.env'].filter((f) => !fs.existsSync(path.join(repo, f)))
    try {
      const r = spawnSync('bash', ['.devcontainer/start.sh'], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, HOME: home, PATH: `${stubs}:${process.env.PATH ?? ''}`, DOCKER_WAIT_SECONDS: '1', START_RETRY_DELAY: '0' },
        timeout: 120_000,
      })
      expect(r.status).toBe(0) // always exits 0
      const written = fs.readFileSync(log, 'utf8')
      expect(written.split('\n')[0]).toMatch(/status: PROBLEMS$/)
      expect(written).toContain('Could not resolve the frontend URL')
      expect(fs.existsSync(`${log}.tmp`)).toBe(false)
    } finally {
      for (const f of created) fs.rmSync(path.join(repo, f), { force: true })
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(stubs, { recursive: true, force: true })
    }
  }, 150_000)
})
