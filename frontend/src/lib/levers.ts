import { AxiosError } from 'axios'
import { LeverFilter, PublicLever, PublishedValue, TypedValue } from '../types/levers'

const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''))

/** A lever value as text, for public pages and the review grid. */
export function formatLeverValue(lever: Pick<PublicLever, 'type' | 'inputFormat' | 'unit'>, value: TypedValue | PublishedValue | null | undefined): string {
  if (!value) return 'Not recorded yet'
  if (value.unknown) return 'Unknown'
  switch (lever.type) {
    case 'MEASUREMENT': {
      if (lever.inputFormat === 'DIMENSIONS' && value.dimensions) {
        const { lengthIn, widthIn, heightIn } = value.dimensions
        const fold = value.bool === null ? '' : value.bool ? ', one-hand fold' : ', two-hand fold'
        return `${trim(lengthIn)} × ${trim(widthIn)} × ${trim(heightIn)} in (${trim(value.number ?? 0)} ${lever.unit})${fold}`
      }
      return value.number === null ? 'Unknown' : `${trim(value.number)} ${lever.unit ?? ''}`.trim()
    }
    case 'CATEGORY':
      return value.text ?? 'Unknown'
    case 'COMPATIBILITY_LIST':
      return value.list.length ? value.list.join(', ') : 'None listed'
    case 'BOOLEAN':
      return value.bool === null ? 'Unknown' : value.bool ? 'Yes' : 'No'
  }
}

export function formatNumber(n: number): string {
  return trim(n)
}

/** Serialize filters the way the API reads them: lever[<id>][min]=… (qs nested syntax). */
export function filterParams(filters: Record<string, LeverFilter>): URLSearchParams {
  const p = new URLSearchParams()
  for (const [id, f] of Object.entries(filters)) {
    if (f.min !== undefined) p.set(`lever[${id}][min]`, String(f.min))
    if (f.max !== undefined) p.set(`lever[${id}][max]`, String(f.max))
    if (f.in && f.in.length) p.set(`lever[${id}][in]`, f.in.join(','))
    if (f.has) p.set(`lever[${id}][has]`, f.has)
    if (f.is) p.set(`lever[${id}][is]`, f.is)
  }
  return p
}

export function isActive(f: LeverFilter | undefined): boolean {
  return !!f && (f.min !== undefined || f.max !== undefined || !!f.in?.length || !!f.has || !!f.is)
}

/** The API's error message, if any. */
export function apiError(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof AxiosError) {
    const data: unknown = err.response?.data
    if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') return data.error
  }
  return fallback
}

/** Per-row CSV errors from an import, if the API returned them. */
export function apiRowErrors(err: unknown): { row: number; error: string }[] {
  if (err instanceof AxiosError) {
    const data: unknown = err.response?.data
    if (data && typeof data === 'object' && 'rows' in data && Array.isArray(data.rows)) {
      return data.rows.filter((r): r is { row: number; error: string } =>
        !!r && typeof r === 'object' && typeof (r as { row: unknown }).row === 'number' && typeof (r as { error: unknown }).error === 'string')
    }
  }
  return []
}
