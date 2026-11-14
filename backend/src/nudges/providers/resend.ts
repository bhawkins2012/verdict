// Resend client over plain fetch (no SDK dependency). docs/adr-nudges.md D1.
//
// UNVERIFIED: written against Resend's public API documentation (POST /emails, Bearer auth,
// Idempotency-Key header, { id } response). It has not been exercised against the real service,
// because no API key is available. Verify with a key before relying on it (see CLAUDE.md, Nudges).
import { z } from 'zod'
import { EmailMessage, EmailProvider, EmailProviderError } from './types'

const RESEND_URL = 'https://api.resend.com/emails'
const responseSchema = z.object({ id: z.string().min(1) })

export class ResendProvider implements EmailProvider {
  readonly name = 'resend' as const
  readonly real = true

  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs = 10_000,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    let res: Response
    try {
      res = await this.fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          headers: message.headers,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      // Network failure or the AbortSignal timeout: transient.
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      throw new EmailProviderError(`Resend request failed: ${reason}`, true)
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      // 429 (rate limited) and 5xx are transient; every other 4xx is permanent.
      const retryable = res.status === 429 || res.status >= 500
      throw new EmailProviderError(`Resend responded ${res.status}: ${detail}`, retryable, res.status)
    }

    const body = responseSchema.safeParse(await res.json().catch(() => null))
    if (!body.success) {
      // Accepted (2xx) but unexpected shape: do not retry, or the user could get the email twice.
      throw new EmailProviderError('Resend accepted the request but returned an unexpected response', false, res.status)
    }
    return { providerMessageId: body.data.id }
  }
}
