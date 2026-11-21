// What a failed model call records: the API's error type and message (redacted, capped) and request id,
// never request content. No network.
import Anthropic from '@anthropic-ai/sdk'
import { API_MESSAGE_MAX, describeModelError, modelErrorText } from '../../src/generation/apiError'
import { apiError } from './helpers'

describe('describeModelError', () => {
  it('keeps the status, the API error type and message, and the request id', () => {
    const d = describeModelError(apiError(400, 'invalid_request_error', 'Schema is too complex for compilation.'))
    expect(d.code).toBe('api_error:400')
    expect(modelErrorText(d)).toBe('api_error:400: invalid_request_error: "Schema is too complex for compilation." (request_id req_011CPROBE)')
    expect(d.meta).toMatchObject({ status: 400, errorType: 'invalid_request_error', apiMessage: 'Schema is too complex for compilation.', requestId: 'req_011CPROBE', errorClass: 'BadRequestError' })
  })

  it('redacts keys and addresses, keeps one line, and caps the message', () => {
    const d = describeModelError(apiError(401, 'authentication_error', `invalid x-api-key sk-ant-api03-abcDEF_123-xyz for\nowner@example.com ${'x'.repeat(500)}`))
    expect(d.detail).not.toMatch(/sk-ant-api03|owner@example\.com|\n/)
    expect(d.detail).toContain('[key]')
    expect(d.detail).toContain('[email]')
    expect(d.meta.apiMessage?.length).toBe(API_MESSAGE_MAX)
  })

  it('a body without error.message adds only what is known; never the SDK message (it can be the whole body)', () => {
    const d = describeModelError(new Anthropic.APIError(529, { type: 'overloaded_error' }, 'Overloaded', new Headers()))
    expect(modelErrorText(d)).toBe('api_error:529')
  })

  it('connection errors and SDK errors keep the SDK text; other errors only their class', () => {
    expect(modelErrorText(describeModelError(new Anthropic.APIConnectionTimeoutError()))).toBe('api_error:connection: APIConnectionTimeoutError: Request timed out.')
    expect(modelErrorText(describeModelError(new Anthropic.AnthropicError('Streaming is required for operations that may take longer than 10 minutes.'))))
      .toBe('api_error:unknown: AnthropicError: Streaming is required for operations that may take longer than 10 minutes.')
    expect(modelErrorText(describeModelError(new TypeError('prompt text could be here')))).toBe('api_error:unknown: TypeError')
  })
})
