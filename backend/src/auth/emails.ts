// Transactional account emails (docs/adr-email-verification.md D10): plain, short, no images, no tracking.
// Not marketing, so no unsubscribe link; the footer carries the postal address (placeholder until set).
import { EmailMessage } from '../nudges/providers'
import { escapeHtml } from '../nudges/email'

export interface AccountEmailSettings {
  fromEmail: string
  postalAddress: string
}

export function message(
  settings: AccountEmailSettings,
  m: { to: string; subject: string; paragraphs: string[]; link?: { href: string; label: string }; idempotencyKey: string }
): EmailMessage {
  const text = [
    ...m.paragraphs.flatMap((p) => [p, '']),
    ...(m.link ? [`${m.link.label}: ${m.link.href}`, ''] : []),
    '--',
    `Verdict · ${settings.postalAddress}`,
  ].join('\n')
  const html = [
    ...m.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    ...(m.link ? [`<p><a href="${escapeHtml(m.link.href)}">${escapeHtml(m.link.label)}</a></p>`] : []),
    '<hr>',
    `<p style="color:#666;font-size:12px">Verdict · ${escapeHtml(settings.postalAddress)}</p>`,
  ].join('\n')
  return { to: m.to, from: settings.fromEmail, subject: m.subject, text, html, headers: {}, idempotencyKey: m.idempotencyKey }
}

export function renderVerificationEmail(input: { to: string; link: string; tokenId: string }, settings: AccountEmailSettings): EmailMessage {
  return message(settings, {
    to: input.to,
    subject: 'Confirm your email for Verdict',
    paragraphs: [
      'Confirm this address to get review check-ins by email.',
      'The link works once and expires in 24 hours. If you didn\'t create a Verdict account, ignore this email.',
    ],
    link: { href: input.link, label: 'Confirm your email address' },
    idempotencyKey: `verify/${input.tokenId}`,
  })
}

export function renderSignupAttemptEmail(input: { to: string; loginUrl: string; eventId: string }, settings: AccountEmailSettings): EmailMessage {
  return message(settings, {
    to: input.to,
    subject: 'Someone tried to create a Verdict account with your email',
    paragraphs: [
      'Someone tried to create a new Verdict account with this email address, which already has an account.',
      'If it was you, sign in with your existing account. If it wasn\'t, nothing was changed. If you never created a Verdict account and cannot sign in, someone may have used your address: contact support.',
    ],
    link: { href: input.loginUrl, label: 'Sign in to Verdict' },
    idempotencyKey: `signup-attempt/${input.eventId}`,
  })
}

export function renderEmailChangedEmail(input: { to: string; newAddressMasked: string; changeId: string }, settings: AccountEmailSettings): EmailMessage {
  return message(settings, {
    to: input.to,
    subject: 'The email address on your Verdict account was changed',
    paragraphs: [
      `The email address on your Verdict account was changed to ${input.newAddressMasked}.`,
      'If you didn\'t do this, contact support right away.',
    ],
    idempotencyKey: `email-changed/${input.changeId}`,
  })
}
