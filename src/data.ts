import type { FileSystemLike, Primitive, Row, SalesConfig, SalesDataset } from './types.js'

function extension(path: string): string {
  return path.match(/\.[^.\\/]+$/)?.[0].toLowerCase() ?? ''
}

function coerce(value: string): Primitive {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  const number = Number(trimmed)
  if (Number.isFinite(number) && /^[-+]?\d+(\.\d+)?$/.test(trimmed)) return number
  return trimmed
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (char === '"') {
      if (quoted && next === '"') { cell += '"'; index += 1 } else quoted = !quoted
    } else if (char === delimiter && !quoted) {
      row.push(cell); cell = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1
      row.push(cell); cell = ''
      if (row.some((value) => value.trim())) rows.push(row)
      row = []
    } else {
      cell += char
    }
  }
  row.push(cell)
  if (row.some((value) => value.trim())) rows.push(row)
  return rows
}

function objectRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'object' && value !== null && Array.isArray((value as { rows?: unknown }).rows)) return (value as { rows: unknown[] }).rows
  throw new Error('JSON source must be an array or an object with a rows array')
}

function normalizeRow(value: unknown, index: number): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`row ${index + 1} must be an object`)
  const row: Row = {}
  for (const [key, cell] of Object.entries(value)) {
    if (cell === null || typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') row[key] = cell
    else if (cell === undefined) row[key] = undefined
    else row[key] = JSON.stringify(cell)
  }
  return row
}

export async function readSalesDataset(fs: FileSystemLike, config: SalesConfig, path: string, signal?: AbortSignal): Promise<SalesDataset> {
  const target = await fs.resolve(path, { signal })
  const info = await fs.stat(target, signal)
  if (!info || info.type !== 'file') throw new Error(`Sales data file not found: ${path}`)
  if ((info.size ?? 0) > config.maxFileBytes) throw new Error(`File exceeds maxFileBytes (${config.maxFileBytes})`)
  const text = await fs.readText(target, signal)
  if (text.length > config.maxTextChars) throw new Error(`File exceeds maxTextChars (${config.maxTextChars})`)
  const ext = extension(path)
  let rows: Row[]
  const warnings: string[] = []
  if (ext === '.csv' || ext === '.tsv') {
    const table = parseDelimited(text, ext === '.tsv' ? '\t' : ',')
    const headers = (table.shift() ?? []).map((header, index) => header.trim() || `column_${index + 1}`)
    rows = table.slice(0, config.maxRows).map((cells) => Object.fromEntries(headers.map((header, index) => [header, coerce(cells[index] ?? '')])))
    if (table.length > config.maxRows) warnings.push(`Rows truncated at maxRows (${config.maxRows})`)
  } else if (ext === '.jsonl' || ext === '.ndjson') {
    rows = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, config.maxRows).map((line, index) => normalizeRow(JSON.parse(line) as unknown, index))
  } else if (ext === '.json') {
    rows = objectRows(JSON.parse(text) as unknown).slice(0, config.maxRows).map(normalizeRow)
  } else {
    throw new Error(`Unsupported sales dataset extension: ${ext || 'unknown'}`)
  }
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  if (rows.length === 0) warnings.push('Dataset contains no rows')
  return { source: path, rows, columns, warnings }
}

export function valueString(value: Primitive | undefined): string {
  return value === null || value === undefined ? '' : String(value)
}

export function numberValue(value: Primitive | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(/[,￥¥$€\s]/g, ''))
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function findField(columns: string[], preferred: string | undefined, candidates: string[]): string | undefined {
  if (preferred && columns.includes(preferred)) return preferred
  const lowered = columns.map((column) => ({ column, lower: column.toLowerCase() }))
  return candidates.map((candidate) => candidate.toLowerCase()).flatMap((candidate) => lowered.filter((item) => item.lower === candidate || item.lower.includes(candidate)).map((item) => item.column))[0]
}
