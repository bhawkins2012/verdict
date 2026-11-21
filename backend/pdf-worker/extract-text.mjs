// PDF text extraction in its own process (docs/adr-generation-run.md section 5 A2). Reads the PDF bytes on
// stdin and writes {"pages": [...]} or {"error": "..."} on stdout. Run with a memory cap and a timeout by
// src/generation/fetch/pdf.ts: the parser handles untrusted files, so a crash or hang stays here.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const MAX_PAGES = 200

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return new Uint8Array(Buffer.concat(chunks))
}

try {
  const data = await readStdin()
  const doc = await getDocument({
    data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false,
  }).promise
  const pages = []
  for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    pages.push(content.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join(''))
  }
  process.stdout.write(JSON.stringify({ pages, numPages: doc.numPages }))
} catch (err) {
  process.stdout.write(JSON.stringify({ error: err && err.name === 'PasswordException' ? 'encrypted' : 'parse_failed' }))
}
