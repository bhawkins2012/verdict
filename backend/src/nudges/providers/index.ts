import { NudgeConfig } from '../config'
import { ConsoleProvider } from './console'
import { ResendProvider } from './resend'
import { EmailProvider } from './types'

export * from './types'
export { ConsoleProvider, dryRunOutbox, clearDryRunOutbox } from './console'
export { ResendProvider } from './resend'

export function createProvider(config: NudgeConfig): EmailProvider {
  if (config.provider === 'resend') {
    // loadNudgeConfig guarantees the key is present for resend.
    return new ResendProvider(config.resendApiKey ?? '')
  }
  return new ConsoleProvider()
}
