// robots.txt (docs/adr-generation-run.md D6.4): parsed with robots-parser for our product token.
import robotsParser from 'robots-parser'

export const USER_AGENT_TOKEN = 'VerdictBot'
export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000

/** "ok": rules apply; "allow_all": robots.txt answered 4xx (RFC 9309); "disallow_all": 5xx, network error or a redirect loop. */
export type RobotsStatus = 'ok' | 'allow_all' | 'disallow_all'

export interface RobotsDecision { allowed: boolean; crawlDelaySec: number | null }

export function decideRobots(status: RobotsStatus, robotsTxt: string | null, url: string): RobotsDecision {
  if (status === 'allow_all') return { allowed: true, crawlDelaySec: null }
  if (status === 'disallow_all') return { allowed: false, crawlDelaySec: null }
  const origin = new URL(url).origin
  const robots = robotsParser(`${origin}/robots.txt`, robotsTxt ?? '')
  const allowed = robots.isAllowed(url, USER_AGENT_TOKEN)
  const delay = robots.getCrawlDelay(USER_AGENT_TOKEN)
  return { allowed: allowed !== false, crawlDelaySec: typeof delay === 'number' && Number.isFinite(delay) ? Math.min(Math.ceil(delay), 60) : null }
}
