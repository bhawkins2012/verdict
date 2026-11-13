/**
 * Turn the TRUST_PROXY environment variable into a value for Express's `trust proxy` setting.
 *
 * - unset / empty  -> 1 (trust exactly one proxy hop: the nearest reverse proxy or load balancer)
 * - "2", "3", ...  -> that many hops;  "0" or "false" -> trust no proxy (client connects directly)
 * - anything else  -> passed to Express as an IP / CIDR / name list, e.g. "loopback, 10.0.0.0/8"
 *
 * Never `true`, and never a match-everything subnet: those trust every hop in X-Forwarded-For, so a
 * client can send a forged header and pick its own IP (and its own rate-limit bucket). That
 * misconfiguration fails at startup instead of being accepted silently.
 */
export function parseTrustProxy(raw: string | undefined): number | string | false {
  const value = (raw ?? '').trim()
  if (value === '') return 1
  if (/^\d+$/.test(value)) return Number(value)
  if (value.toLowerCase() === 'false') return false

  const permissive = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part === 'true' || part === '0.0.0.0/0' || part === '::/0')
  if (permissive.length > 0) {
    throw new Error(
      `TRUST_PROXY=${JSON.stringify(raw)} would trust every hop in X-Forwarded-For, letting clients spoof their IP. ` +
        'Use a hop count (e.g. 1) or a list of proxy addresses/subnets.'
    )
  }
  return value
}
