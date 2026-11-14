import { localDayBounds, nextLocalSendTime, resolveTimeZone, zonedTimeToUtc } from '../../src/nudges/time'

const NY = 'America/New_York'

describe('time zones and DST', () => {
  it('spring-forward: a send hour that does not exist moves forward by the gap (02:00 -> 03:00 EDT)', () => {
    // 2026-03-08: US clocks jump from 02:00 EST to 03:00 EDT; 02:xx does not exist.
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 0 }, NY).toISOString()).toBe('2026-03-08T07:00:00.000Z')
    expect(nextLocalSendTime(new Date('2026-03-08T05:00:00Z'), NY, 2).toISOString()).toBe('2026-03-08T07:00:00.000Z')
  })

  it('fall-back: a send hour that happens twice resolves to the first occurrence (01:00 EDT, not EST)', () => {
    // 2026-11-01: 01:00-01:59 happens twice (EDT then EST).
    expect(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 0 }, NY).toISOString()).toBe('2026-11-01T05:00:00.000Z')
    expect(nextLocalSendTime(new Date('2026-11-01T04:30:00Z'), NY, 1).toISOString()).toBe('2026-11-01T05:00:00.000Z')
  })

  it('the hour after a DST change is right on both sides', () => {
    // From 10:00 local the day before, the next 09:00 is on the DST-change day itself.
    expect(nextLocalSendTime(new Date('2026-03-07T15:00:00Z'), NY, 9).toISOString()).toBe('2026-03-08T13:00:00.000Z') // 09:00 EDT
    expect(nextLocalSendTime(new Date('2026-10-31T14:00:00Z'), NY, 9).toISOString()).toBe('2026-11-01T14:00:00.000Z') // 09:00 EST
  })

  it('half-hour offset zone: 09:00 in Asia/Kolkata is 03:30 UTC', () => {
    expect(nextLocalSendTime(new Date('2026-06-01T00:00:00Z'), 'Asia/Kolkata', 9).toISOString()).toBe('2026-06-01T03:30:00.000Z')
    // Already past 09:00 IST (04:00Z = 09:30 IST) -> next day
    expect(nextLocalSendTime(new Date('2026-06-01T04:00:00Z'), 'Asia/Kolkata', 9).toISOString()).toBe('2026-06-02T03:30:00.000Z')
  })

  it.each(['Not/AZone', '', 'UTC+5', 'america/new york'])('an invalid time zone (%j) falls back to UTC', (tz) => {
    expect(resolveTimeZone(tz)).toBe('UTC')
    expect(nextLocalSendTime(new Date('2026-06-01T08:00:00Z'), tz, 9).toISOString()).toBe('2026-06-01T09:00:00.000Z')
  })

  it('the send time is never before the requested instant (exactly on the hour counts)', () => {
    const exactly = new Date('2026-06-01T09:00:00Z')
    expect(nextLocalSendTime(exactly, 'UTC', 9).getTime()).toBe(exactly.getTime())
    expect(nextLocalSendTime(new Date('2026-06-01T09:00:01Z'), 'UTC', 9).toISOString()).toBe('2026-06-02T09:00:00.000Z')
  })

  it('local day bounds follow DST (the fall-back day has 25 hours)', () => {
    const { start, end } = localDayBounds(new Date('2026-11-01T12:00:00Z'), NY)
    expect(start.toISOString()).toBe('2026-11-01T04:00:00.000Z')
    expect(end.toISOString()).toBe('2026-11-02T05:00:00.000Z')
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25)
  })
})
