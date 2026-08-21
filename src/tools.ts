import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readSalesDataset } from './data.js'
import { jsonValue, renderResult, resultEnvelope, resultSchema, type ResultLineage } from './output.js'
import { analyzeSalesFunnel, buildSalesOnboarding, forecastPipeline, generatePlaybook, reviewDeal, reviewOffer, reviewProductSalesHandoff } from './sales.js'
import { replacementDiff } from './markdown.js'
import type { FileSystemLike, SalesConfig } from './types.js'
import { auditNoteForTool, readSalesNote, scanSalesVault } from './vault.js'

function salesOutput(maxChars: number) {
  return { schema: resultSchema, render: (_args: unknown, value: unknown) => renderResult(value, maxChars) }
}

function wrapResult(value: unknown, options: { lineage?: ResultLineage[]; assumptions?: string[]; nextActions?: string[] } = {}) {
  const warnings = typeof value === 'object' && value !== null && 'warnings' in value && Array.isArray(value.warnings)
    ? value.warnings.filter((warning): warning is string => typeof warning === 'string')
    : []
  return resultEnvelope({ data: jsonValue(value), warnings, assumptions: options.assumptions, lineage: options.lineage, nextActions: options.nextActions })
}

function parseList(value: string | undefined, label: string): string[] {
  if (!value?.trim()) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean)
  } catch { /* fall through to line mode */ }
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).length > 0
    ? value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    : (() => { throw new Error(`${label} must be a JSON array or newline-separated list`) })()
}

function parseObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(value) as unknown } catch (error) { throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`) }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`)
  return parsed as Record<string, unknown>
}

async function ensureInsideRoot(fs: FileSystemLike, config: SalesConfig, path: string, signal?: AbortSignal): Promise<void> {
  const root = await fs.resolve(config.defaultRoot, { signal })
  const target = await fs.resolve(path, { signal })
  if (!fs.contains(root, target)) throw new Error(`Path is outside configured defaultRoot: ${path}`)
}

export function registerSalesTools(ctx: Context, config: SalesConfig, fs: FileSystemLike): void {
  ctx.tools.register(defineTool({
    name: 'sales_onboarding',
    description: 'Run a read-only sales readiness check across local sales notes and pipeline data. It identifies the current commercial gate and the smallest next actions.',
    parameters: {
      root: { type: 'string', description: 'Optional directory under defaultRoot.' },
    },
    output: salesOutput(config.maxResultChars),
    async execute(args, exec) {
      const root = args.root?.trim() || config.defaultRoot
      await ensureInsideRoot(fs, config, root, exec.signal)
      const scan = await scanSalesVault(fs, root, config, exec.signal)
      const result = buildSalesOnboarding(root, scan)
      return wrapResult(result, { lineage: [{ source: root }], nextActions: result.topActions })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sales_audit_note',
    description: 'Audit one Markdown sales context, deal review, pipeline review, offer review or playbook for metadata, evidence lineage and next-action completeness.',
    parameters: {
      path: { type: 'string', required: true, description: 'Markdown sales artifact under defaultRoot.' },
    },
    output: salesOutput(config.maxResultChars),
    async execute(args, exec) {
      await ensureInsideRoot(fs, config, args.path, exec.signal)
      const note = await readSalesNote(fs, args.path, config, exec.signal)
      const result = auditNoteForTool(note)
      return wrapResult(result, { lineage: [{ source: args.path }], nextActions: result.nextActions })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sales_funnel_analyze',
    description: 'Analyze a local CSV, TSV, JSON or JSONL sales pipeline by stage, amount and optional close date. Returns stage conversion, pipeline share, weighted amount and data gaps.',
    parameters: {
      path: { type: 'string', required: true, description: 'Sales pipeline dataset under defaultRoot.' },
      stageField: { type: 'string', description: 'Stage column; inferred when omitted.' },
      amountField: { type: 'string', description: 'Amount column; inferred when omitted.' },
      dateField: { type: 'string', description: 'Expected close date column; inferred when omitted.' },
      probabilityJson: { type: 'string', description: 'Optional JSON object mapping normalized stage to probability.' },
    },
    output: salesOutput(config.maxResultChars),
    async execute(args, exec) {
      await ensureInsideRoot(fs, config, args.path, exec.signal)
      const dataset = await readSalesDataset(fs, config, args.path, exec.signal)
      const result = analyzeSalesFunnel(dataset, args)
      ctx.emit('sales/analysis-completed', { kind: 'funnel', source: args.path, warningCount: result.warnings.length })
      return wrapResult(result, { lineage: [{ source: args.path, fields: [result.stageField, ...(result.amountField ? [result.amountField] : []), ...(result.dateField ? [result.dateField] : [])] }], nextActions: result.nextActions })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sales_product_handoff_review',
    description: 'Consume and validate a dsh-product product-sales-handoff. It checks the product decision gate, value evidence, proof points, commercial context and customer next action before sales progression.',
    parameters: {
      handoffJson: { type: 'string', required: true, description: 'JSON returned by product_sales_handoff, including its result envelope or data object.' },
    },
    output: salesOutput(config.maxResultChars),
    async execute(args) {
      const parsed = parseObject(args.handoffJson, 'handoffJson')
      const data = typeof parsed.data === 'object' && parsed.data !== null && !Array.isArray(parsed.data) ? parsed.data as Record<string, unknown> : parsed
      const review = reviewProductSalesHandoff(data)
      return wrapResult(review, { lineage: review.source ? [{ source: review.source }] : [], nextActions: review.nextActions })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sales_deal_review',
    description: 'Review one opportunity using Problem, Impact, Buyer, Process, Timing, Competition and Commitment evidence. The score is evidence coverage, not close probability.',
    parameters: {
      deal: { type: 'string', required: true, description: 'Deal or opportunity name.' },
      facts: { type: 'string', required: true, description: 'JSON object. Each field may be a value or {value,status,source}; status is observed, customer-stated, estimated, inferred or missing.' },
      source: { type: 'string', description: 'Source note or dataset path.' },
    },
    output: salesOutput(config.maxResultChars),
    async execute(args) {
      const result = reviewDeal(args.deal, parseObject(args.facts, 'facts'), args.source)
      return wrapResult(result, { lineage: args.source ? [{ source: args.source }] : [], assumptions: result.assumptions, nextActions: result.nextActions })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sales_offer_review',
    description: 'Review an offer for value evidence, price source, cost basis, discount authority and payment terms. It does not set a price or approve a discount.',
    parameters: {
      offer: { type: 'string', required: true, description: 'Offer, product or proposal name.' },
      valueEvidence: { type: 'string', description: 'JSON array or newline-separated value evidence.' },
      facts: { type: 'string', required: true, description: 'JSON object with targetCustomer, problem, desiredOutcome, priceSource, costBasis, discountAuthority and paymentTerms.' },
    },
    output: salesOutput(config.maxResultChars),
    async execute(args) {
      const result = reviewOffer(args.offer, { valueEvidence: parseList(args.valueEvidence, 'valueEvidence'), facts: parseObject(args.facts, 'facts') })
      return wrapResult(result, { nextActions: result.nextActions })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sales_forecast',
    description: 'Create a weighted sales pipeline forecast from amount, stage and expected close date fields. Default probabilities are explicit heuristics and never a revenue guarantee.',
    parameters: {
      path: { type: 'string', required: true, description: 'Sales pipeline dataset under defaultRoot.' },
      stageField: { type: 'string', description: 'Stage column; inferred when omitted.' },
      amountField: { type: 'string', description: 'Amount column; inferred when omitted.' },
      closeDateField: { type: 'string', description: 'Expected close date column; inferred when omitted.' },
      currency: { type: 'string', description: 'Currency code; defaults to plugin configuration.' },
      asOf: { type: 'string', description: 'ISO date used to identify stale open opportunities.' },
      probabilityJson: { type: 'string', description: 'Optional JSON object mapping normalized stage to probability.' },
    },
    output: salesOutput(config.maxResultChars),
    async execute(args, exec) {
      await ensureInsideRoot(fs, config, args.path, exec.signal)
      const dataset = await readSalesDataset(fs, config, args.path, exec.signal)
      const result = forecastPipeline(dataset, { ...args, currency: args.currency?.trim() || config.defaultCurrency })
      return wrapResult(result, { lineage: [{ source: args.path }], assumptions: result.assumptions, nextActions: result.nextActions })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sales_playbook_generate',
    description: 'Generate a concise sales playbook or deal-push artifact from approved inputs. It returns Markdown for review and does not contact customers.',
    parameters: {
      title: { type: 'string', required: true, description: 'Artifact title.' },
      targetCustomer: { type: 'string', required: true, description: 'Target customer or buyer.' },
      salesMotion: { type: 'string', required: true, description: 'Direct, partner, self-serve or hybrid motion.' },
      valueProposition: { type: 'string', required: true, description: 'Evidence-backed value proposition.' },
      discoveryQuestions: { type: 'string', required: true, description: 'JSON array or newline-separated questions.' },
      qualificationCriteria: { type: 'string', required: true, description: 'JSON array or newline-separated criteria.' },
      objections: { type: 'string', description: 'JSON array or newline-separated objection-handling principles.' },
      nextStep: { type: 'string', required: true, description: 'One observable customer next action.' },
      source: { type: 'string', description: 'Source note or handoff path.' },
    },
    output: salesOutput(config.maxResultChars),
    async execute(args) {
      const result = generatePlaybook({ title: args.title, targetCustomer: args.targetCustomer, salesMotion: args.salesMotion, valueProposition: args.valueProposition, discoveryQuestions: parseList(args.discoveryQuestions, 'discoveryQuestions'), qualificationCriteria: parseList(args.qualificationCriteria, 'qualificationCriteria'), objections: parseList(args.objections, 'objections'), nextStep: args.nextStep, source: args.source })
      return wrapResult(result, { lineage: args.source ? [{ source: args.source }] : [], nextActions: result.nextActions })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sales_apply_artifact',
    description: 'Preview or apply a complete Markdown sales artifact under defaultRoot using a stale-version guard. Set confirm=true only after explicit approval.',
    parameters: {
      path: { type: 'string', required: true, description: 'Markdown sales artifact to update.' },
      content: { type: 'string', required: true, description: 'Complete replacement Markdown content.' },
      confirm: { type: 'boolean', required: true, description: 'false previews only; true applies the guarded write.' },
    },
    output: salesOutput(config.maxResultChars),
    async execute(args, exec) {
      await ensureInsideRoot(fs, config, args.path, exec.signal)
      if (args.content.length > config.maxTextChars) throw new Error(`Replacement exceeds maxTextChars (${config.maxTextChars})`)
      const target = await fs.resolve(args.path, { signal: exec.signal })
      const info = await fs.stat(target, exec.signal)
      if (!info || info.type !== 'file') throw new Error(`File not found: ${args.path}`)
      const current = await fs.readText(target, exec.signal)
      if (!args.confirm) {
        ctx.emit('sales/report-previewed', { path: args.path })
        return wrapResult({ status: 'preview-only', path: args.path, changed: args.content !== current, applied: false, diff: replacementDiff(current, args.content) }, { nextActions: ['审阅 diff；明确确认后再以 confirm=true 写回。'] })
      }
      await fs.writeText(target, args.content, { kind: 'replaceIfVersion', version: info.version }, exec.signal)
      ctx.emit('sales/report-applied', { path: args.path })
      return wrapResult({ status: 'applied', path: args.path, changed: args.content !== current, applied: true, guarded: true }, { lineage: [{ source: args.path }] })
    },
  }))
}
