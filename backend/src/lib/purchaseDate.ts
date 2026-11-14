import { z } from 'zod'

const LATEST_UTC_OFFSET_MS = 14 * 60 * 60 * 1000 // UTC+14, the most advanced time zone

/**
 * Optional purchase date for a review thread, as a calendar date "YYYY-MM-DD" (stored as UTC midnight).
 * Future dates are rejected. A date-only value has no time zone, so "today" is judged by the most
 * advanced zone on Earth: nobody is told their own today is in the future, and every date that is in
 * the future for everyone is refused.
 */
export function purchaseDateSchema(now: () => Date = () => new Date()) {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'purchasedAt must be a date in the form YYYY-MM-DD')
    .transform((value, ctx) => {
      const date = new Date(`${value}T00:00:00.000Z`)
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'purchasedAt is not a valid date' })
        return z.NEVER
      }
      const latestToday = new Date(now().getTime() + LATEST_UTC_OFFSET_MS).toISOString().slice(0, 10)
      if (value > latestToday) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'purchasedAt cannot be in the future' })
        return z.NEVER
      }
      return date
    })
}
