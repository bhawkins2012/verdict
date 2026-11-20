// A minimal text PDF writer for dry-run fixtures and tests (one Helvetica text block per page). Pages
// with no lines make a PDF with no text, which the extractor treats as scanned.

function escapePdf(s: string): string {
  return s.replace(/[\\()]/g, (m) => `\\${m}`)
}

export function makeTextPdf(pages: string[][]): Uint8Array {
  const objects: string[] = []
  const add = (body: string) => { objects.push(body); return objects.length }
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const contents = pages.map((lines) => {
    const stream = lines.length ? `BT /F1 11 Tf 14 TL 50 750 Td ${lines.map((l) => `(${escapePdf(l)}) Tj T*`).join(' ')} ET` : ''
    return add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
  })
  const pagesId = objects.length + contents.length + 1
  const pageIds = contents.map((c) =>
    add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`))
  add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`)
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, 'latin1'))
}
