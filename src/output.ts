import type { JsonValue } from '@deepseek-ai/dsh-tools'

export interface ResultLineage {
  source: string
  fields?: string[]
  window?: { start?: string; end?: string; timezone?: string }
}

export const resultSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    ok: { type: 'boolean' as const },
    data: { type: 'json' as const },
    warnings: { type: 'array' as const, items: { type: 'string' as const } },
    assumptions: { type: 'array' as const, items: { type: 'string' as const } },
    lineage: { type: 'array' as const, items: { type: 'object' as const, additionalProperties: true as const } },
    nextActions: { type: 'array' as const, items: { type: 'string' as const } },
  },
}

export function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export function resultEnvelope<T extends JsonValue>(options: {
  data: T
  warnings?: string[]
  assumptions?: string[]
  lineage?: ResultLineage[]
  nextActions?: string[]
}) {
  return {
    ok: true,
    data: options.data,
    warnings: [...(options.warnings ?? [])],
    assumptions: [...(options.assumptions ?? [])],
    lineage: [...(options.lineage ?? [])] as unknown as Array<Record<string, JsonValue>>,
    nextActions: [...(options.nextActions ?? [])],
  }
}

export function renderResult(value: unknown, maxChars: number): Array<{ type: 'text'; text: string }> {
  const text = JSON.stringify(value, null, 2)
  const rendered = text.length > maxChars
    ? `${text.slice(0, maxChars)}\n... result truncated by dsh-sales; use a narrower source or scope ...`
    : text
  return [{ type: 'text' as const, text: rendered }]
}
