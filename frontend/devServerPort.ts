// The Vite dev-server port. The backend derives Codespaces links from the same FRONTEND_PORT
// (backend/src/lib/frontendUrl.ts) and reads it from backend/.env, so Vite reads that file too: the shell
// wins, then backend/.env, then 5173.
export const DEFAULT_DEV_PORT = 5173

export function devServerPort(shellEnv: Record<string, string | undefined>, backendEnv: Record<string, string | undefined>): number {
  for (const raw of [shellEnv.FRONTEND_PORT, backendEnv.FRONTEND_PORT]) {
    const n = raw && /^\d+$/.test(raw.trim()) ? Number(raw) : 0
    if (n > 0 && n < 65536) return n
  }
  return DEFAULT_DEV_PORT
}
