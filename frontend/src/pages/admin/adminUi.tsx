// Small shared pieces of the admin screens.
import clsx from 'clsx'
import { RunStatus } from '../../types/levers'

const RUN_LABEL: Record<RunStatus, string> = {
  ACTIVE: 'running', READY_FOR_REVIEW: 'ready for review', STALLED: 'stalled', FAILED: 'failed', CANCELLED: 'cancelled', PUBLISHED: 'published',
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={clsx('px-1.5 py-0.5 rounded text-[11px]', {
      'bg-blue-50 text-blue-800': status === 'ACTIVE',
      'bg-green-50 text-green-900': status === 'READY_FOR_REVIEW' || status === 'PUBLISHED',
      'bg-amber-100 text-amber-900': status === 'STALLED',
      'bg-red-50 text-red-800': status === 'FAILED',
      'bg-ink-100 text-ink-600': status === 'CANCELLED',
    })}>{RUN_LABEL[status]}</span>
  )
}

export const usd = (n: number | null | undefined) => (n === null || n === undefined ? '–' : `$${n.toFixed(n < 1 ? 4 : 2)}`)

/** Readable names for the auto-approval checks and fetch outcomes. */
export const CHECK_LABEL: Record<string, string> = {
  brand_domain: 'Brand domain', brandDomain: 'Brand domain', fetch: 'Page fetch', modelNamed: 'Model named on page',
  nodeFit: 'Belongs in this node', duplicate: 'Not a duplicate', extraction: 'Extraction',
}

export const OUTCOME_LABEL: Record<string, string> = {
  OK: 'fetched', ROBOTS_DISALLOWED: 'robots.txt disallows', NOT_ALLOWED: 'not allowed', HTTP_ERROR: 'HTTP error', BLOCKED: 'blocked by the site',
  UNSUPPORTED_TYPE: 'unsupported type', TOO_LARGE: 'too large', NETWORK: 'network error', SCANNED_PDF: 'scanned PDF (skipped)',
}
