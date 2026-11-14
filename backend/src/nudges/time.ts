// Time-zone helpers for nudge scheduling, built on Intl only (no dependency). See docs/adr-nudges.md D5.
//
// Disambiguation follows Temporal's "compatible" policy:
// - a local time that does not exist (spring-forward gap) moves forward by the length of the gap,
//   e.g. 02:00 on the US spring-forward day becomes 03:00;
// - a local time that happens twice (fall-back overlap) resolves to the earlier occurrence.

const DAY_MS = 24 * 60 * 60 * 1000

interface LocalParts {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    })
    formatters.set(timeZone, f)
  }
  return f
}

/** True if `timeZone` is an IANA name this runtime understands. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/** The zone to use for scheduling: the user's zone if valid, else UTC. */
export function resolveTimeZone(timeZone: string | null | undefined): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC'
}

function localParts(instant: Date, timeZone: string): LocalParts {
  const parts: Record<string, number> = {}
  for (const p of formatterFor(timeZone).formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute }
}

/** Offset of `timeZone` from UTC at `instant`, in ms (positive east of UTC). Minute precision. */
function offsetMs(instantMs: number, timeZone: string): number {
  const p = localParts(new Date(instantMs), timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  return asUtc - Math.floor(instantMs / 60000) * 60000
}

function sameLocal(instantMs: number, want: LocalParts, timeZone: string): boolean {
  const p = localParts(new Date(instantMs), timeZone)
  return p.year === want.year && p.month === want.month && p.day === want.day && p.hour === want.hour && p.minute === want.minute
}

/** The UTC instant of a local wall-clock time in `timeZone`, disambiguated as described above. */
export function zonedTimeToUtc(want: LocalParts, timeZone: string): Date {
  const guess = Date.UTC(want.year, want.month - 1, want.day, want.hour, want.minute)
  // The offsets in force a day either side cover any single transition near this time.
  const offsetBefore = offsetMs(guess - DAY_MS, timeZone)
  const offsetAfter = offsetMs(guess + DAY_MS, timeZone)
  const candidates = [...new Set([guess - offsetBefore, guess - offsetAfter])]
  const valid = candidates.filter((c) => sameLocal(c, want, timeZone))
  if (valid.length > 0) return new Date(Math.min(...valid)) // overlap: earlier occurrence
  // Gap: the wall time does not exist. Using the pre-transition offset lands after the gap,
  // shifted forward by its length.
  return new Date(guess - offsetBefore)
}

function addLocalDays(p: LocalParts, days: number): LocalParts {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 0, minute: 0 }
}

/**
 * The first instant at or after `notBefore` that is `hour`:00 local time in `timeZone`
 * (an invalid zone falls back to UTC). On a spring-forward day where `hour` does not exist,
 * this is the shifted time (e.g. 03:00 for a 02:00 send hour).
 */
export function nextLocalSendTime(notBefore: Date, timeZone: string, hour: number): Date {
  const zone = resolveTimeZone(timeZone)
  const today = localParts(notBefore, zone)
  for (let offset = 0; offset < 3; offset++) {
    const day = addLocalDays(today, offset)
    const candidate = zonedTimeToUtc({ ...day, hour, minute: 0 }, zone)
    if (candidate.getTime() >= notBefore.getTime()) return candidate
  }
  /* istanbul ignore next: unreachable, one of the next three local days always qualifies */
  throw new Error('nextLocalSendTime: no candidate found')
}

/** [start, end) of the local calendar day containing `instant` in `timeZone`, as UTC instants. */
export function localDayBounds(instant: Date, timeZone: string): { start: Date; end: Date } {
  const zone = resolveTimeZone(timeZone)
  const today = localParts(instant, zone)
  return {
    start: zonedTimeToUtc({ ...addLocalDays(today, 0) }, zone),
    end: zonedTimeToUtc({ ...addLocalDays(today, 1) }, zone),
  }
}
