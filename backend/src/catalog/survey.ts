// Owner-survey CSV import (docs/adr-levers.md D7; per decision node since docs/adr-generation-run.md D2).
// All or nothing: every row is validated first, any error returns the row numbers, and nothing is written.
// (The Phase A lever-value CSV import is gone: values come from extraction or a manual value with a quote.)
import { parse } from 'csv-parse/sync'
import { NodeKind } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { normalizeName } from './text'

export const MAX_CSV_ROWS = 2000

export class CsvRowsError extends AppError {
  constructor(public rows: { row: number; error: string }[]) {
    super(400, `The file has ${rows.length} invalid row${rows.length === 1 ? '' : 's'}; nothing was imported`, { rows })
  }
}

/**
 * Parse CSV text with a header row into records keyed by lower-cased header, each with the line it
 * starts on (as a spreadsheet numbers rows: the header is line 1; blank lines and quoted line breaks count).
 */
export function parseCsv(text: string, required: readonly string[]): { row: Record<string, string>; line: number }[] {
  let records: { row: Record<string, string>; line: number }[]
  try {
    const parsed: { record: Record<string, string>; info: { lines: number; raw?: string } }[] = parse(text, {
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      info: true,
      raw: true,
    })
    // info.lines is the line where the record ends; subtract the line breaks inside it (the raw text
    // also carries the blank lines before it and its own line end, which are not part of the record).
    const innerBreaks = (raw: string) => raw.replace(/^(\r?\n)+/, '').replace(/\r?\n$/, '').match(/\n/g)?.length ?? 0
    records = parsed.map((p) => ({ row: p.record, line: p.info.lines - innerBreaks(p.info.raw ?? '') }))
  } catch (err) {
    throw new AppError(400, `Not a valid CSV file: ${err instanceof Error ? err.message.slice(0, 200) : 'parse error'}`)
  }
  if (records.length === 0) throw new AppError(400, 'The file has no data rows')
  if (records.length > MAX_CSV_ROWS) throw new AppError(400, `At most ${MAX_CSV_ROWS} rows per file`)
  const missing = required.filter((c) => !(c in records[0].row))
  if (missing.length > 0) throw new AppError(400, `Missing column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`)
  return records
}

// ── Survey ───────────────────────────────────────────────────────────────────────────────────────────
export const SURVEY_COLUMNS = ['lever', 'rank', 'respondents'] as const

export async function importSurvey(nodeId: string, filename: string, text: string, userId: string) {
  const node = await prisma.taxonomyNode.findUnique({ where: { id: nodeId }, select: { id: true, kind: true } })
  if (!node) throw new AppError(404, 'Node not found')
  if (node.kind !== NodeKind.DECISION) throw new AppError(400, 'Surveys rank the levers of a decision node')
  const records = parseCsv(text, SURVEY_COLUMNS)
  const errors: { row: number; error: string }[] = []
  const rows: { leverName: string; rank: number; respondentCount: number }[] = []
  const seen = new Set<string>()
  records.forEach(({ row: r, line }) => {
    const name = r.lever ?? ''
    const rank = Number(r.rank)
    const respondents = Number(r.respondents)
    if (name.length < 1 || name.length > 60) errors.push({ row: line, error: 'lever must be 1 to 60 characters' })
    else if (seen.has(normalizeName(name))) errors.push({ row: line, error: `duplicate lever "${name}"` })
    else if (!Number.isInteger(rank) || rank < 1) errors.push({ row: line, error: 'rank must be a whole number from 1' })
    else if (!Number.isInteger(respondents) || respondents < 0) errors.push({ row: line, error: 'respondents must be a whole number from 0' })
    else rows.push({ leverName: name, rank, respondentCount: respondents })
    seen.add(normalizeName(name))
  })
  if (errors.length > 0) throw new CsvRowsError(errors)
  return prisma.surveyImport.create({
    data: { nodeId, filename, uploadedById: userId, rowCount: rows.length, rankings: { create: rows } },
    include: { rankings: { orderBy: { rank: 'asc' } } },
  })
}

