// The browser-facing URL of the frontend: links in emails (verification, nudges, unsubscribe) and the
// CORS origin. One helper, used by the backend config, app.ts and .devcontainer/start.sh (through
// src/scripts/frontendUrl.ts), so they can never disagree.
//
// In a GitHub Codespace, http://localhost:5173 only works inside the Codespace; a link in an email opened
// on another device must use the forwarded address. So when FRONTEND_URL is unset or points at localhost
// and the Codespaces variables are present, the URL is derived as
//   https://$CODESPACE_NAME-<frontend port>.$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
// The frontend port is FRONTEND_PORT, else the port in a localhost FRONTEND_URL, else 5173 (Vite's
// server.port reads FRONTEND_PORT too).

export const DEFAULT_FRONTEND_PORT = 5173

export type FrontendUrlSource = 'FRONTEND_URL' | 'codespaces' | 'default'

export interface ResolvedFrontendUrl {
  /** No trailing slash. */
  url: string
  source: FrontendUrlSource
  port: number
  /** True if the URL only works on the machine running the app (localhost, 127.0.0.1, ...). */
  isLocalhost: boolean
}

type Env = Record<string, string | undefined>

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

export function isLocalhostUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return LOCAL_HOSTS.has(host) || host.endsWith('.localhost')
  } catch {
    return false
  }
}

function portOf(url: string | undefined): number | undefined {
  if (!url) return undefined
  try {
    const p = new URL(url).port
    return p ? Number(p) : undefined
  } catch {
    return undefined
  }
}

const validPort = (n: number | undefined): n is number => n !== undefined && Number.isInteger(n) && n > 0 && n < 65536

export function resolveFrontendUrl(env: Env = process.env): ResolvedFrontendUrl {
  const configured = env.FRONTEND_URL?.trim().replace(/\/+$/, '') || undefined
  const configuredIsLocal = configured ? isLocalhostUrl(configured) : true
  const fromEnv = env.FRONTEND_PORT ? Number(env.FRONTEND_PORT) : undefined
  const port = [fromEnv, configuredIsLocal ? portOf(configured) : undefined].find(validPort) ?? DEFAULT_FRONTEND_PORT

  // Codespaces sets both. Validate them: they become part of every emailed link.
  const name = env.CODESPACE_NAME?.trim()
  const domain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?.trim()
  const inCodespace = !!name && !!domain && /^[a-z0-9-]+$/i.test(name) && /^[a-z0-9.-]+$/i.test(domain)

  if (configuredIsLocal && inCodespace) {
    return { url: `https://${name}-${port}.${domain}`, source: 'codespaces', port, isLocalhost: false }
  }
  if (configured) return { url: configured, source: 'FRONTEND_URL', port, isLocalhost: configuredIsLocal }
  return { url: `http://localhost:${port}`, source: 'default', port, isLocalhost: true }
}

/**
 * Allowed CORS origins: the resolved URL plus the local frontend origin (in a Codespace the app is also
 * opened through VS Code's localhost forward). Requests normally reach the API through Vite's same-origin
 * proxy, so this matters only for direct calls.
 */
export function corsOrigins(resolved: ResolvedFrontendUrl = resolveFrontendUrl()): string[] {
  const local = `http://localhost:${resolved.port}`
  return resolved.url === local ? [local] : [resolved.url, local]
}

/** Startup messages (no secrets): the resolved URL, and a loud warning when real email would carry localhost links. */
export function frontendUrlStartupMessages(resolved: ResolvedFrontendUrl, realEmailProvider: boolean): { info: string; warn?: string } {
  const info = `Frontend URL for email links and CORS: ${resolved.url} (from ${resolved.source})`
  if (realEmailProvider && resolved.isLocalhost) {
    return {
      info,
      warn:
        `A REAL email provider is active but email links point at ${resolved.url}, which only works on this machine. ` +
        'Set FRONTEND_URL to the public address of the frontend (in a Codespace, leave it unset or on localhost to derive it).',
    }
  }
  return { info }
}
