// What a failed model call records on its stage, its generation call row and the log: enough to diagnose it
// (status, the API's error type and message, the request id) and nothing that should not be stored.
//
// The API's error body is { type: "error", error: { type, message }, request_id }. Its message explains a
// rejected request ("Schema is too complex for compilation", an unsupported parameter, ...). We keep that
// message, redacted and capped, but never the SDK's Error.message (for a body without error.message it is
// the whole body as JSON) and never request content: no prompt text, documents or headers.
import Anthropic from '@anthropic-ai/sdk'

const API_KEY = /\bsk-ant-[A-Za-z0-9_-]+/g
const EMAIL = /[^\s@'"`<>(),;:]+@[^\s@'"`<>(),;:]+\.[^\s@'"`<>(),;:]+/g
export const API_MESSAGE_MAX = 300

/** Redacted, single-line, capped text from the API or the SDK. */
export function redactApiText(text: string): string {
  const clean = text.replace(API_KEY, '[key]').replace(EMAIL, '[email]').replace(/\s+/g, ' ').trim()
  return clean.length > API_MESSAGE_MAX ? `${clean.slice(0, API_MESSAGE_MAX - 1)}…` : clean
}

export interface ModelErrorDescription {
  /** Short code: `api_error:<status>`, `api_error:connection` or `api_error:unknown`. */
  code: string
  /** For people: `invalid_request_error: "…" (request_id req_…)`, or null when there is nothing safe to add. */
  detail: string | null
  /** Structured fields for the log. */
  meta: { status: number | null; errorType: string | null; apiMessage: string | null; requestId: string | null; errorClass: string }
}

export function describeModelError(err: unknown): ModelErrorDescription {
  const errorClass = err instanceof Error ? (err.constructor.name && err.constructor.name !== 'Error' ? err.constructor.name : err.name) : typeof err
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : null
    const errorType = err.type ?? null
    const apiMessage = typeof err.apiMessage === 'string' && err.apiMessage ? redactApiText(err.apiMessage) : null
    const requestId = typeof err.requestID === 'string' && err.requestID ? redactApiText(err.requestID) : null
    const code = `api_error:${status ?? 'connection'}`
    let detail: string | null
    if (status === null) {
      // Connection errors and timeouts: the SDK's own text ("Connection error.", "Request timed out.").
      detail = `${errorClass}: ${redactApiText(err.message)}`
    } else {
      const parts = [errorType ?? undefined, apiMessage ? `"${apiMessage}"` : undefined].filter(Boolean)
      detail = parts.length ? parts.join(': ') : null
      if (requestId) detail = `${detail ?? 'no error body'} (request_id ${requestId})`
    }
    return { code, detail, meta: { status, errorType, apiMessage, requestId, errorClass } }
  }
  // Errors the SDK raises before sending (for example "Streaming is required …") are its own text; any other
  // error is named by class only, since its message could hold anything.
  const detail = err instanceof Anthropic.AnthropicError ? `${errorClass}: ${redactApiText(err.message)}` : errorClass
  return { code: 'api_error:unknown', detail, meta: { status: null, errorType: null, apiMessage: null, requestId: null, errorClass } }
}

/** The text stored as a stage's, an item's or a call's error. */
export function modelErrorText(d: ModelErrorDescription): string {
  return d.detail ? `${d.code}: ${d.detail}` : d.code
}
