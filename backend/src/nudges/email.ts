// Nudge email content (docs/adr-nudges.md D6): plain, short, no images, no tracking pixels.
import { ReviewStage } from '@prisma/client'
import { EmailMessage } from './providers'
import { STAGE_LABEL } from './planner'
import { unsubscribeUrl } from './unsubscribe'

export interface NudgeEmailInput {
  nudgeId: string
  stage: ReviewStage
  productId: string
  productName: string
  userId: string
  to: string
  displayName: string
  /** true if the schedule is anchored on a purchase date the user gave */
  fromPurchase: boolean
}

export interface EmailSettings {
  frontendUrl: string
  fromEmail: string
  unsubscribeSecret: string
  postalAddress: string
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export function reviewLink(frontendUrl: string, input: Pick<NudgeEmailInput, 'productId' | 'stage' | 'nudgeId'>): string {
  const params = new URLSearchParams({ stage: input.stage, nudgeId: input.nudgeId })
  return `${frontendUrl}/products/${encodeURIComponent(input.productId)}/review?${params.toString()}`
}

export function renderNudgeEmail(input: NudgeEmailInput, settings: EmailSettings): EmailMessage {
  const label = STAGE_LABEL[input.stage]
  const link = reviewLink(settings.frontendUrl, input)
  const unsubscribe = unsubscribeUrl(settings.frontendUrl, settings.unsubscribeSecret, input.userId)
  const since = input.fromPurchase ? 'since you got' : 'since you started reviewing'
  // Header injection guard: product names are user-supplied.
  const subjectName = input.productName.replace(/[\r\n]+/g, ' ').slice(0, 120)

  const text = [
    `Hi ${input.displayName},`,
    '',
    `It's been ${label} ${since} ${input.productName}. Has your opinion changed?`,
    '',
    `Write your ${label} review:`,
    link,
    '',
    '--',
    "You're getting this because you turned on review reminders in Verdict.",
    `Stop these emails: ${unsubscribe}`,
    settings.postalAddress,
  ].join('\n')

  const html = [
    `<p>Hi ${escapeHtml(input.displayName)},</p>`,
    `<p>It's been ${escapeHtml(label)} ${since} ${escapeHtml(input.productName)}. Has your opinion changed?</p>`,
    `<p><a href="${escapeHtml(link)}">Write your ${escapeHtml(label)} review</a></p>`,
    '<hr>',
    `<p>You're getting this because you turned on review reminders in Verdict.<br>`,
    `<a href="${escapeHtml(unsubscribe)}">Stop these emails</a><br>`,
    `${escapeHtml(settings.postalAddress)}</p>`,
  ].join('\n')

  return {
    to: input.to,
    from: settings.fromEmail,
    subject: `How is your ${subjectName} holding up?`,
    text,
    html,
    headers: {
      'List-Unsubscribe': `<${unsubscribe}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    idempotencyKey: `nudge/${input.nudgeId}`,
  }
}
