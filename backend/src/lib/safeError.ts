// Error text that is safe to log for account emails: never an address, a password hash or a token.
//
// Prisma's PrismaClientValidationError prints the whole failing call, arguments included (in the Codespace
// run: "Unknown argument `claimedAt`" after a dump of the data, which for a user insert holds the address
// and the password hash). Keep only its final explanation line, then redact anything address-, bcrypt- or
// token-shaped from whatever remains (provider errors can quote the recipient too).

const EMAIL = /[^\s@'"`<>(),;:]+@[^\s@'"`<>(),;:]+\.[^\s@'"`<>(),;:]+/g
const BCRYPT = /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g
const TOKEN = /\b[A-Za-z0-9_-]{43,}\b/g // base64url of 32+ bytes (verifiers), long hex hashes

export function safeErrorMessage(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err)
  if (err instanceof Error && err.name === 'PrismaClientValidationError') {
    const lines = message.split('\n').map((l) => l.trim()).filter(Boolean)
    message = lines[lines.length - 1] ?? ''
  }
  return message.replace(EMAIL, '[email]').replace(BCRYPT, '[hash]').replace(TOKEN, '[token]').slice(0, 300)
}
