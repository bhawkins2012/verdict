// Dry-run provider: never touches the network. Default until a sending domain is chosen (ADR Q1).
import { randomUUID } from 'crypto'
import { logger } from '../../lib/logger'
import { EmailMessage, EmailProvider } from './types'

export interface OutboxEntry extends EmailMessage {
  providerMessageId: string
  at: string
}

const OUTBOX_LIMIT = 50
const outbox: OutboxEntry[] = []

/** Most recent dry-run messages, newest first (exposed by a dev-only route). */
export function dryRunOutbox(): readonly OutboxEntry[] {
  return [...outbox].reverse()
}

export function clearDryRunOutbox(): void {
  outbox.length = 0
}

export class ConsoleProvider implements EmailProvider {
  readonly name = 'console' as const
  readonly real = false

  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    const providerMessageId = `dry-run-${randomUUID()}`
    outbox.push({ ...message, providerMessageId, at: new Date().toISOString() })
    if (outbox.length > OUTBOX_LIMIT) outbox.shift()
    logger.info('Email (dry run, not sent)', {
      to: message.to,
      subject: message.subject,
      idempotencyKey: message.idempotencyKey,
      providerMessageId,
    })
    return { providerMessageId }
  }
}
