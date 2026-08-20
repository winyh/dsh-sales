import { findField, numberValue, valueString } from './data.js'
import { artifactHeader, parseNote } from './markdown.js'
import type { DealReviewResult, EvidenceStatus, ForecastResult, FunnelAnalysis, GeneratedArtifact, OfferReviewResult, ReadinessStatus, Row, SalesConfig, SalesDataset, SalesDecision, SalesNote, SalesOnboardingResult, SalesScanResult } from './types.js'

const stageOrder = ['lead', 'qualified', 'discovery', 'solution', 'proposal', 'negotiation', 'closed-won', 'closed-lost', 'renewal', 'expansion'] as const
const stageProbabilities: Record<string, number> = {
  lead: 0.05,
  qualified: 0.15,
  discovery: 0.25,
  solution: 0.4,
  proposal: 0.6,
  negotiation: 0.8,
  'closed-won': 1,
  'closed-lost': 0,
  renewal: 0.75,
  expansion: 0.65,
}

const aliases: Record<string, string> = {
  线索: 'lead', leads: 'lead', lead: 'lead',
  mql: 'qualified', sql: 'qualified', 资格: 'qualified', qualified: 'qualified',
  discovery: 'discovery', 需求沟通: 'discovery', 需求: 'discovery',
  solution: 'solution', 方案: 'solution', demo: 'solution', 演示: 'solution',
  proposal: 'proposal', 报价: 'proposal', 提案: 'proposal',
  negotiation: 'negotiation', 谈判: 'negotiation', 商务: 'negotiation',
  'closed-won': 'closed-won', won: 'closed-won', 赢单: 'closed-won', 成交: 'closed-won',
  'closed-lost': 'closed-lost', lost: 'closed-lost', 输单: 'closed-lost', 失单: 'closed-lost',
  renewal: 'renewal', 续费: 'renewal',
  expansion: 'expansion', 扩单: 'expansion', 增购: 'expansion',
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim()
}

export function normalizeStage(value: unknown): string {
  const key = text(value).toLowerCase()
  return aliases[key] ?? (key.replace(/\s+/g, '-') || 'unknown')
}

function percent(value: number): number {
  return Math.round(value * 1000) / 10
}

function amountFromRow(row: Row, field: string | undefined): number {
  return field ? numberValue(row[field]) ?? 0 : 0
}

export function analyzeSalesFunnel(dataset: SalesDataset, options: { stageField?: string; amountField?: string; dateField?: string; probabilityJson?: string } = {}): FunnelAnalysis {
  const stageField = findField(dataset.columns, options.stageField, ['stage', 'status', 'opportunity_stage', '阶段', '商机阶段', '状态'])
  const amountField = findField(dataset.columns, options.amountField, ['amount', 'value', 'revenue', 'deal_value', '金额', '合同金额', '收入'])
  const dateField = findField(dataset.columns, options.dateField, ['close_date', 'expected_close', 'date', '预计成交日', '成交日期'])
  if (!stageField) throw new Error('Could not identify a stage field; provide stageField explicitly')
  const customProbabilities = options.probabilityJson ? JSON.parse(options.probabilityJson) as Record<string, number> : {}
  const grouped = new Map<string, { records: number; amount: number }>()
  for (const row of dataset.rows) {
    const stage = normalizeStage(row[stageField])
    const current = grouped.get(stage) ?? { records: 0, amount: 0 }
    current.records += 1
    current.amount += amountFromRow(row, amountField)
    grouped.set(stage, current)
  }
  const order = [...new Set([...stageOrder, ...grouped.keys()])].filter((stage) => grouped.has(stage))
  const totalAmount = [...grouped.values()].reduce((sum, item) => sum + item.amount, 0)
  const stages = order.map((stage, index) => {
    const current = grouped.get(stage) ?? { records: 0, amount: 0 }
    const previous = index > 0 ? grouped.get(order[index - 1] ?? '')?.records ?? 0 : 0
    const probability = customProbabilities[stage] ?? stageProbabilities[stage] ?? 0.2
    return {
      stage,
      records: current.records,
      amount: Math.round(current.amount * 100) / 100,
      conversionFromPrevious: index === 0 || previous === 0 ? null : percent(current.records / previous),
      shareOfPipeline: totalAmount === 0 ? null : percent(current.amount / totalAmount),
      probability,
    }
  })
  const weightedAmount = stages.reduce((sum, stage) => sum + stage.amount * stage.probability, 0)
  const missing: string[] = []
  if (!amountField) missing.push('amount field')
  if (!dateField) missing.push('close date field')
  if (dataset.rows.some((row) => !text(row[stageField]))) missing.push('rows with missing stage')
  const warnings = [...dataset.warnings]
  if (stages.some((stage) => stage.stage === 'unknown')) warnings.push('Some stage values could not be mapped to the standard stage taxonomy')
  return {
    source: dataset.source,
    stageField,
    ...(amountField ? { amountField } : {}),
    ...(dateField ? { dateField } : {}),
    stages: stages.map(({ probability: _probability, ...stage }) => stage),
    totals: { records: dataset.rows.length, amount: Math.round(totalAmount * 100) / 100, weightedAmount: Math.round(weightedAmount * 100) / 100 },
    missing,
    warnings,
    nextActions: missing.length > 0 ? [`补齐 ${missing.join('、')} 后再使用销售管道做决策。`] : ['按 Owner、来源和预计成交窗口切分，定位阶段停留和客户动作缺口。'],
  }
}

function factStatus(value: unknown): EvidenceStatus {
  if (typeof value !== 'object' || value === null) return text(value) ? 'inferred' : 'missing'
  const status = text((value as { status?: unknown }).status)
  return ['observed', 'customer-stated', 'estimated', 'inferred', 'missing'].includes(status) ? status as EvidenceStatus : text((value as { value?: unknown }).value) ? 'inferred' : 'missing'
}

function factValue(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'value' in value) return text((value as { value?: unknown }).value)
  return text(value)
}

function factSource(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'source' in value) return text((value as { source?: unknown }).source) || undefined
  return undefined
}

function reviewMarkdown(result: Omit<DealReviewResult, 'markdown'>): string {
  const lines = [artifactHeader('deal-review', `${result.deal} 商机复盘`, result.readiness === 'ready' ? 'ready-for-review' : 'draft', { deal: result.deal, decision: result.decision }), '## 结论', '', `- 判断：${result.decision}`, `- 准备度：${result.readiness}`, `- 评分：${result.score}%`, '', '## 资格证据', '', '| 维度 | 状态 | 证据 | 来源 |', '| --- | --- | --- | --- |']
  for (const item of result.evidence) lines.push(`| ${item.dimension} | ${item.status} | ${item.value || '缺失'} | ${item.source ?? ''} |`)
  lines.push('', '## 风险与缺口', '', ...(result.risks.length > 0 ? result.risks.map((item) => `- ${item}`) : ['- 未识别到额外风险']), '', '## 下一步', '', ...result.nextActions.map((item) => `- ${item}`))
  return lines.join('\n')
}

export function reviewDeal(deal: string, facts: Record<string, unknown>, source?: string): DealReviewResult {
  const dimensions = ['problem', 'impact', 'buyer', 'process', 'timing', 'competition', 'commitment']
  const labels: Record<string, string> = { problem: 'Problem', impact: 'Impact', buyer: 'Buyer', process: 'Process', timing: 'Timing', competition: 'Competition', commitment: 'Commitment' }
  const evidence = dimensions.map((dimension) => {
    const evidenceSource = factSource(facts[dimension]) ?? source
    return { dimension: labels[dimension] ?? dimension, status: factStatus(facts[dimension]), value: factValue(facts[dimension]), ...(evidenceSource ? { source: evidenceSource } : {}) }
  })
  const strong = evidence.filter((item) => item.status === 'observed' || item.status === 'customer-stated').length
  const missing = evidence.filter((item) => item.status === 'missing' || !item.value).map((item) => item.dimension)
  const risks: string[] = []
  if (evidence.find((item) => item.dimension === 'Commitment')?.status === 'missing') risks.push('没有客户可验证动作，当前可能只是兴趣而不是机会')
  if (evidence.find((item) => item.dimension === 'Buyer')?.status === 'missing') risks.push('决策人、经济买方或批准路径不清楚')
  if (evidence.find((item) => item.dimension === 'Impact')?.status === 'missing') risks.push('价值没有连接到基线、金额、时间或风险结果')
  if (evidence.find((item) => item.dimension === 'Process')?.status === 'missing') risks.push('采购、技术、法务或上线流程未知')
  const score = percent(strong / dimensions.length)
  const readiness: ReadinessStatus = missing.length === 0 && strong >= 5 ? 'ready' : strong >= 3 ? 'partial' : 'blocked'
  const decision: SalesDecision = readiness === 'ready' ? 'advance' : readiness === 'partial' ? 'validate' : 'hold'
  const nextActions = missing.length > 0 ? missing.slice(0, 3).map((item) => `补齐 ${item}：让客户或内部 Owner 给出可引用证据、负责人和日期`) : ['确认客户下一步动作、完成日期和验收证据', '核对报价、成本、付款和折扣授权，再进入商业审查']
  const assumptions = ['评分只表示证据覆盖率，不是成交概率', '未提供的字段保持缺失，不自动视为否定或通过']
  const base = { deal, decision, readiness, score, evidence, missing, risks, nextActions, assumptions }
  return { ...base, markdown: reviewMarkdown(base) }
}

export function reviewOffer(offer: string, input: { valueEvidence?: string[]; facts: Record<string, unknown> }): OfferReviewResult {
  const fields = ['targetCustomer', 'problem', 'desiredOutcome', 'priceSource', 'costBasis', 'discountAuthority', 'paymentTerms']
  const labels: Record<string, string> = { targetCustomer: '目标客户', problem: '客户问题', desiredOutcome: '期望结果', priceSource: '报价来源', costBasis: '成本基础', discountAuthority: '折扣授权', paymentTerms: '付款条款' }
  const commercialFacts = fields.map((field) => ({ field: labels[field] ?? field, status: factStatus(input.facts[field]), value: factValue(input.facts[field]) }))
  const missing = commercialFacts.filter((fact) => fact.status === 'missing' || !fact.value).map((fact) => fact.field)
  const risks: string[] = []
  if (missing.includes('报价来源')) risks.push('报价没有可核验来源，不能判断是否符合价格政策')
  if (missing.includes('成本基础')) risks.push('缺少成本或贡献毛利基础，不能判断让利风险')
  if (missing.includes('折扣授权')) risks.push('折扣权限不清，不能把降价写进承诺')
  if ((input.valueEvidence ?? []).length === 0) risks.push('没有价值证据，价格只能被客户当成成本比较')
  const readiness: ReadinessStatus = missing.length === 0 && risks.length === 0 ? 'ready' : missing.length <= 2 ? 'partial' : 'blocked'
  const decision = readiness === 'ready' ? 'approve-for-review' : readiness === 'partial' ? 'revise' : 'blocked'
  const nextActions = missing.length > 0 ? [`补齐：${missing.slice(0, 4).join('、')}`] : ['让客户确认结果、范围、时间和验收方式，再进入正式报价审批']
  const lines = [artifactHeader('offer-review', `${offer} 报价与变现审查`, readiness === 'ready' ? 'ready-for-review' : 'draft'), '## 价值证据', '', ...(input.valueEvidence?.length ? input.valueEvidence.map((item) => `- ${item}`) : ['- 缺失']), '', '## 商业事实', '', '| 字段 | 状态 | 值 |', '| --- | --- | --- |', ...commercialFacts.map((fact) => `| ${fact.field} | ${fact.status} | ${fact.value || '缺失'} |`), '', '## 风险', '', ...(risks.length ? risks.map((risk) => `- ${risk}`) : ['- 未发现阻塞风险']), '', '## 下一步', '', ...nextActions.map((action) => `- ${action}`)]
  return { offer, decision, readiness, valueEvidence: input.valueEvidence ?? [], commercialFacts, risks, missing, nextActions, markdown: lines.join('\n') }
}

export function forecastPipeline(dataset: SalesDataset, options: { stageField?: string; amountField?: string; closeDateField?: string; currency: string; asOf?: string; probabilityJson?: string }): ForecastResult {
  const stageField = findField(dataset.columns, options.stageField, ['stage', 'status', 'opportunity_stage', '阶段', '商机阶段', '状态'])
  const amountField = findField(dataset.columns, options.amountField, ['amount', 'value', 'revenue', 'deal_value', '金额', '合同金额', '收入'])
  const closeDateField = findField(dataset.columns, options.closeDateField, ['close_date', 'expected_close', '预计成交日', '成交日期'])
  if (!stageField) throw new Error('Could not identify a stage field; provide stageField explicitly')
  const custom = options.probabilityJson ? JSON.parse(options.probabilityJson) as Record<string, number> : {}
  const asOf = options.asOf ? new Date(options.asOf) : new Date()
  if (Number.isNaN(asOf.getTime())) throw new Error(`Invalid asOf date: ${options.asOf}`)
  const grouped = new Map<string, { records: number; amount: number }>()
  let rawAmount = 0
  let weightedAmount = 0
  let missingAmount = 0
  let missingCloseDate = 0
  let staleRecords = 0
  for (const row of dataset.rows) {
    const stage = normalizeStage(row[stageField])
    const amount = amountField ? numberValue(row[amountField]) : undefined
    const probability = custom[stage] ?? stageProbabilities[stage] ?? 0.2
    if (amount === undefined) missingAmount += 1
    else { rawAmount += amount; weightedAmount += amount * probability }
    const closeDate = closeDateField ? new Date(valueString(row[closeDateField])) : undefined
    if (!closeDateField || !valueString(row[closeDateField]) || Number.isNaN(closeDate?.getTime())) missingCloseDate += 1
    else if (closeDate && closeDate < asOf && !['closed-won', 'closed-lost'].includes(stage)) staleRecords += 1
    const current = grouped.get(stage) ?? { records: 0, amount: 0 }
    current.records += 1
    current.amount += amount ?? 0
    grouped.set(stage, current)
  }
  const byStage = [...grouped.entries()].map(([stage, value]) => {
    const probability = custom[stage] ?? stageProbabilities[stage] ?? 0.2
    return { stage, records: value.records, amount: Math.round(value.amount * 100) / 100, probability, weightedAmount: Math.round(value.amount * probability * 100) / 100 }
  }).sort((a, b) => stageOrder.indexOf(a.stage as typeof stageOrder[number]) - stageOrder.indexOf(b.stage as typeof stageOrder[number]))
  const warnings = [...dataset.warnings]
  if (!amountField) warnings.push('No amount field detected; forecast amounts are zero')
  if (staleRecords > 0) warnings.push(`${staleRecords} open records have a close date before asOf`)
  const assumptions = ['Weighted forecast equals amount × stage probability; it is not a revenue commitment', 'Probabilities are heuristic defaults unless probabilityJson or historical conversion evidence is supplied']
  return { source: dataset.source, currency: options.currency, asOf: asOf.toISOString(), records: dataset.rows.length, rawAmount: Math.round(rawAmount * 100) / 100, weightedAmount: Math.round(weightedAmount * 100) / 100, byStage, missingAmount, missingCloseDate, staleRecords, warnings, assumptions, nextActions: missingAmount > 0 || missingCloseDate > 0 ? ['先清理金额、预计成交日和阶段退出条件，再使用预测做资源决策。'] : ['按 Owner、客户分群和成交窗口复核加权管道，标出需要客户承诺的机会。'] }
}

export function generatePlaybook(input: { title: string; targetCustomer: string; salesMotion: string; valueProposition: string; discoveryQuestions: string[]; qualificationCriteria: string[]; objections: string[]; nextStep: string; source?: string }): GeneratedArtifact {
  const lines = [artifactHeader('sales-playbook', input.title, 'draft', { source: input.source }), '## 目标客户与销售动作', '', `- 目标客户：${input.targetCustomer}`, `- 销售动作：${input.salesMotion}`, `- 价值主张：${input.valueProposition}`, '', '## 发现问题', '', ...input.discoveryQuestions.map((item, index) => `${index + 1}. ${item}`), '', '## 资格判断', '', ...input.qualificationCriteria.map((item) => `- ${item}`), '', '## 异议处理原则', '', ...(input.objections.length ? input.objections.map((item) => `- ${item}`) : ['- 先确认问题、影响和决策条件，不直接承诺折扣']), '', '## 下一客户动作', '', `- ${input.nextStep}`, '', '## 证据纪律', '', '- 客户原话、内部判断和待验证假设分开记录。', '- 报价、折扣、交付和日期承诺必须引用来源并经过授权。']
  return { artifactType: 'sales-playbook', title: input.title, status: 'draft', ...(input.source ? { source: input.source } : {}), markdown: lines.join('\n'), nextActions: ['补充来源、Owner、更新时间和验收标准后再作为团队标准。'] }
}

function stale(updated: unknown): boolean {
  if (!updated) return true
  const date = new Date(String(updated))
  return Number.isNaN(date.getTime()) || Date.now() - date.getTime() > 90 * 86_400_000
}

export function auditSalesNote(note: SalesNote): { path: string; title: string; type: string; status: ReadinessStatus; findings: string[]; nextActions: string[] } {
  const findings: string[] = []
  if (!note.frontmatter.type) findings.push('missing type')
  if (!note.frontmatter.status) findings.push('missing status')
  if (!note.frontmatter.owner) findings.push('missing owner')
  if (!note.frontmatter.updated || stale(note.frontmatter.updated)) findings.push('stale or missing updated date')
  if (!note.frontmatter.source && note.externalLinks.length === 0) findings.push('missing source or lineage')
  if (!/下一步|next step|客户动作|owner|负责人/i.test(note.content)) findings.push('missing customer action or owner')
  return { path: note.path, title: note.title, type: text(note.frontmatter.type) || 'untyped', status: findings.length === 0 ? 'ready' : findings.length <= 2 ? 'partial' : 'blocked', findings: findings.length ? findings : ['healthy'], nextActions: findings.length ? ['补齐证据、Owner、日期和下一客户动作，再进入销售 gate。'] : ['复核事实、客户陈述、假设和商业承诺是否分开。'] }
}

export function buildSalesOnboarding(root: string, scan: SalesScanResult): SalesOnboardingResult {
  const dimensions = [
    { id: 'context', label: '客户与价值上下文', evidence: scan.summary.salesNotes > 0 ? [`发现 ${scan.summary.salesNotes} 份销售笔记`] : [], missing: scan.summary.salesNotes > 0 ? [] : ['销售上下文、ICP、JTBD 或价值主张'], nextAction: '先建立 sales-context，并写明来源和目标客户' },
    { id: 'pipeline', label: '商机管道与阶段', evidence: scan.summary.dataFiles > 0 ? [`发现 ${scan.summary.dataFiles} 个数据文件`] : [], missing: scan.summary.dataFiles > 0 ? [] : ['商机或客户推进数据'], nextAction: '补充带阶段、金额、Owner 和日期的数据' },
    { id: 'evidence', label: '成交证据', evidence: scan.summary.salesNotes > 0 && scan.summary.missingSources === 0 ? ['销售笔记均有来源'] : [], missing: scan.summary.missingSources > 0 ? ['来源或证据 lineage'] : [], nextAction: '为客户原话、结果和承诺补充来源' },
    { id: 'commercial', label: '报价与商业边界', evidence: [], missing: ['报价来源、成本基础、折扣授权和付款条款'], nextAction: '引用 dsh-business 或批准的商业上下文' },
  ]
  const dimensionsWithStatus = dimensions.map((dimension) => ({ ...dimension, status: dimension.missing.length === 0 ? 'ready' as const : dimension.evidence.length > 0 ? 'partial' as const : 'blocked' as const, score: dimension.missing.length === 0 ? 100 : dimension.evidence.length > 0 ? 50 : 0 }))
  const overallScore = Math.round(dimensionsWithStatus.reduce((sum, dimension) => sum + dimension.score, 0) / dimensionsWithStatus.length)
  const currentStep = dimensionsWithStatus.find((dimension) => dimension.status !== 'ready')?.id as SalesOnboardingResult['currentStep'] ?? 'close'
  return {
    generatedAt: new Date().toISOString(), root, overallStatus: overallScore >= 75 ? 'ready' : overallScore > 0 ? 'partial' : 'blocked', overallScore,
    dimensions: dimensionsWithStatus,
    methods: [
      { id: 'qualification', name: 'MEDDICC / SPICED', status: scan.summary.salesNotes > 0 ? 'partial' : 'not-detected', evidence: [], nextAction: '围绕 Problem、Impact、Buyer、Process、Timing、Commitment 补证据' },
      { id: 'discovery', name: 'SPIN / Gap Selling', status: scan.summary.salesNotes > 0 ? 'partial' : 'not-detected', evidence: [], nextAction: '把客户问题连接到基线和期望结果' },
      { id: 'commercial', name: 'Value Selling / Mutual Action Plan', status: 'not-detected', evidence: [], nextAction: '建立价值证明和客户共同推进计划' },
    ],
    currentStep, topActions: dimensionsWithStatus.filter((dimension) => dimension.status !== 'ready').slice(0, 2).map((dimension) => dimension.nextAction), warnings: scan.errors,
  }
}

export function scanSummaryForOnboarding(root: string, notes: SalesNote[], dataFiles: string[], errors: string[]): SalesScanResult {
  const byType: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  let missingMetadata = 0
  let staleNotes = 0
  let missingSources = 0
  const priorityFiles: SalesScanResult['priorityFiles'] = []
  for (const note of notes) {
    const audit = auditSalesNote(note)
    byType[audit.type] = (byType[audit.type] ?? 0) + 1
    const status = text(note.frontmatter.status) || 'unstated'
    byStatus[status] = (byStatus[status] ?? 0) + 1
    if (!note.frontmatter.type || !note.frontmatter.status) missingMetadata += 1
    if (audit.findings.some((finding) => finding.includes('stale'))) staleNotes += 1
    if (audit.findings.some((finding) => finding.includes('source'))) missingSources += 1
    if (audit.findings[0] !== 'healthy') priorityFiles.push({ path: note.path, title: note.title, type: audit.type, status, reasons: audit.findings })
  }
  return { root, generatedAt: new Date().toISOString(), scannedFiles: notes.length + dataFiles.length, skippedFiles: 0, errors, summary: { salesNotes: notes.length, dataFiles: dataFiles.length, missingMetadata, staleNotes, missingSources, byType, byStatus }, priorityFiles: priorityFiles.toSorted((left, right) => right.reasons.length - left.reasons.length).slice(0, 20) }
}

export function parseSalesNote(path: string, content: string): SalesNote {
  return parseNote(path, content)
}

export function defaultConfigSummary(config: SalesConfig): string {
  return `${config.defaultCurrency}/${config.defaultTimezone}`
}
