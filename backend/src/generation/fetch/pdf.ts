// Text-based PDF manuals (docs/adr-generation-run.md section 5 A2): parsed in a separate Node process
// (pdf-worker/extract-text.mjs) with a memory cap and a timeout. Scanned PDFs (little or no text) are
// reported as such and skipped; no OCR.
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

export const PDF_TIMEOUT_MS = 20_000
/** Average characters of text per page below which a PDF counts as scanned. */
export const SCANNED_CHARS_PER_PAGE = 25

export type PdfText = { ok: true; text: string; pages: number } | { ok: false; reason: 'scanned' | 'parse_failed' | 'encrypted' | 'timeout' }

/** The worker script, found from this file in both src/ and dist/ (both sit three levels below backend/). */
function workerPath(): string {
  const candidate = path.resolve(__dirname, '../../../pdf-worker/extract-text.mjs')
  if (fs.existsSync(candidate)) return candidate
  return path.resolve(process.cwd(), 'pdf-worker/extract-text.mjs')
}

export function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--max-old-space-size=256', workerPath()], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    let settled = false
    const done = (r: PdfText) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
    const timer = setTimeout(() => { child.kill('SIGKILL'); done({ ok: false, reason: 'timeout' }) }, PDF_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { out += d })
    child.on('error', () => done({ ok: false, reason: 'parse_failed' }))
    child.on('close', () => {
      try {
        const parsed: unknown = JSON.parse(out)
        if (typeof parsed === 'object' && parsed !== null && 'pages' in parsed && Array.isArray(parsed.pages)) {
          const pages = parsed.pages.filter((p): p is string => typeof p === 'string')
          const text = pages.map((p) => p.trim()).join('\n\n')
          if (pages.length === 0 || text.replace(/\s+/g, '').length / pages.length < SCANNED_CHARS_PER_PAGE) {
            return done({ ok: false, reason: 'scanned' })
          }
          return done({ ok: true, text, pages: pages.length })
        }
        const error = typeof parsed === 'object' && parsed !== null && 'error' in parsed ? parsed.error : null
        done({ ok: false, reason: error === 'encrypted' ? 'encrypted' : 'parse_failed' })
      } catch {
        done({ ok: false, reason: 'parse_failed' })
      }
    })
    child.stdin.on('error', () => undefined) // the child may exit before reading everything
    child.stdin.end(Buffer.from(bytes))
  })
}
