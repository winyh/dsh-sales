import type { SalesNote } from './types.js'

function scalar(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1)
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  const number = Number(trimmed)
  return Number.isFinite(number) && /^[-+]?\d+(\.\d+)?$/.test(trimmed) ? number : trimmed
}

export function parseNote(path: string, content: string): SalesNote {
  const lines = content.split(/\r?\n/)
  const frontmatter: Record<string, unknown> = {}
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end > 0) for (const line of lines.slice(1, end)) {
      const separator = line.indexOf(':')
      if (separator > 0) frontmatter[line.slice(0, separator).trim()] = scalar(line.slice(separator + 1))
    }
  }
  const headings = lines.filter((line) => /^#{1,6}\s+/.test(line)).map((line) => line.replace(/^#{1,6}\s+/, '').trim())
  const title = headings[0] ?? String(frontmatter.title ?? path.split(/[\\/]/).pop() ?? 'Sales note')
  const externalLinks = [...content.matchAll(/https?:\/\/[^\s)]+/g)].map((match) => match[0])
  return { path, title, content, frontmatter, headings, externalLinks, wordCount: content.trim().split(/\s+/).filter(Boolean).length }
}

export function artifactHeader(type: string, title: string, status: string, fields: Record<string, string | undefined> = {}): string {
  const lines = ['---', `artifact: ${type}`, `status: ${status}`]
  for (const [key, value] of Object.entries(fields)) if (value) lines.push(`${key}: ${value}`)
  lines.push('---', '', `# ${title}`, '')
  return lines.join('\n')
}

export function replacementDiff(before: string, after: string): { beforeLines: number; afterLines: number; changedLines: number; preview: string[] } {
  const left = before.split(/\r?\n/)
  const right = after.split(/\r?\n/)
  const preview: string[] = []
  let changedLines = 0
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === right[index]) continue
    changedLines += 1
    if (preview.length < 20) {
      if (left[index] !== undefined) preview.push(`- ${left[index]}`)
      if (right[index] !== undefined) preview.push(`+ ${right[index]}`)
    }
  }
  return { beforeLines: left.length, afterLines: right.length, changedLines, preview }
}
