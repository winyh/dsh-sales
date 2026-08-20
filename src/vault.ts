import { auditSalesNote, parseSalesNote, scanSummaryForOnboarding } from './sales.js'
import type { FileSystemLike, SalesConfig, SalesNote, SalesScanResult } from './types.js'

const supported = new Set(['.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.ndjson'])

function extension(path: string): string {
  return path.match(/\.[^.\\/]+$/)?.[0].toLowerCase() ?? ''
}

function isSalesNote(note: SalesNote): boolean {
  const type = String(note.frontmatter.type ?? '').toLowerCase()
  return ['sales-context', 'deal-review', 'pipeline-review', 'sales-playbook', 'offer-review', 'win-loss'].includes(type) || /销售|成交|商机|pipeline|deal|MEDDICC|SPIN|报价|复购|扩单/i.test(note.content)
}

function childPath(parent: string, name: string): string {
  return `${parent.replace(/[\\/]+$/, '')}/${name}`
}

export async function readSalesNote(fs: FileSystemLike, path: string, config: SalesConfig, signal?: AbortSignal): Promise<SalesNote> {
  const target = await fs.resolve(path, { signal })
  const info = await fs.stat(target, signal)
  if (!info || info.type !== 'file') throw new Error(`Markdown file not found: ${path}`)
  if ((info.size ?? 0) > config.maxFileBytes) throw new Error(`File exceeds maxFileBytes (${config.maxFileBytes})`)
  const content = await fs.readText(target, signal)
  if (content.length > config.maxTextChars) throw new Error(`File exceeds maxTextChars (${config.maxTextChars})`)
  return parseSalesNote(path, content)
}

export async function scanSalesVault(fs: FileSystemLike, root: string, config: SalesConfig, signal?: AbortSignal): Promise<SalesScanResult> {
  const notes: SalesNote[] = []
  const dataFiles: string[] = []
  const errors: string[] = []
  let scannedFiles = 0
  let skippedFiles = 0
  async function visit(target: unknown, displayPath: string): Promise<void> {
    if (scannedFiles >= config.maxFiles) { skippedFiles += 1; return }
    let entries: Awaited<ReturnType<FileSystemLike['listDir']>>
    try { entries = await fs.listDir(target, signal) } catch (error) { errors.push(`${displayPath}: ${error instanceof Error ? error.message : String(error)}`); return }
    for (const entry of entries) {
      if (scannedFiles >= config.maxFiles) { skippedFiles += 1; continue }
      if (entry.name.startsWith('.')) continue
      const path = childPath(displayPath, entry.name)
      if (entry.type === 'directory') { await visit(entry.target, path); continue }
      const ext = extension(entry.name)
      if (entry.type !== 'file' || !supported.has(ext)) continue
      scannedFiles += 1
      if ((entry.size ?? 0) > config.maxFileBytes) { skippedFiles += 1; errors.push(`${path}: exceeds maxFileBytes`); continue }
      try {
        if (ext === '.md' || ext === '.markdown') {
          const content = await fs.readText(entry.target, signal)
          if (content.length > config.maxTextChars) { skippedFiles += 1; errors.push(`${path}: exceeds maxTextChars`); continue }
          const note = parseSalesNote(path, content)
          if (isSalesNote(note)) notes.push(note)
        } else {
          dataFiles.push(path)
        }
      } catch (error) {
        errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  await visit(await fs.resolve(root, { signal }), root)
  const result = scanSummaryForOnboarding(root, notes, dataFiles, errors)
  result.scannedFiles = scannedFiles
  result.skippedFiles = skippedFiles
  return result
}

export function auditNoteForTool(note: SalesNote) {
  return auditSalesNote(note)
}
