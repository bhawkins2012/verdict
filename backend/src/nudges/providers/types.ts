// Email provider interface (docs/adr-nudges.md D1).

export interface EmailMessage {
  to: string
  from: string
  subject: string
  text: string
  html: string
  /** e.g. List-Unsubscribe, List-Unsubscribe-Post */
  headers: Record<string, string>
  /** Stable per nudge so a retry after a crash is de-duplicated by the provider. */
  idempotencyKey: string
}

export interface EmailProvider {
  readonly name: 'console' | 'resend'
  /** True if this provider delivers real email (subject to NUDGE_REQUIRE_VERIFIED_EMAIL). */
  readonly real: boolean
  send(message: EmailMessage): Promise<{ providerMessageId: string }>
}

export class EmailProviderError extends Error {
  constructor(
    message: string,
    /** true: try again later (network, timeout, 429, 5xx). false: will never succeed (other 4xx). */
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message)
    this.name = 'EmailProviderError'
  }
}
