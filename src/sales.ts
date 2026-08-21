import { findField, numberValue, valueString } from './data.js'
import { artifactHeader, parseNote } from './markdown.js'
import type { BusinessCommercialHandoff, CommercialHandoffReview, CrmImportResult, DealReviewResult, EvidenceStatus, ForecastResult, FunnelAnalysis, GeneratedArtifact, OfferReviewResult, Primitive, ProductSalesHandoff, ProductSalesHandoffReview, ReadinessStatus, Row, SalesConfig, SalesDataset, SalesDecision, SalesFeedbackHandoff, SalesNote, SalesOnboardingResult, SalesScanResult, SalesStageAgingResult, SalesWinLossResult } from './types.js'

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

function listField(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => text(item)).filter(Boolean)
}

export function reviewProductSalesHandoff(input: Record<string, unknown>): ProductSalesHandoffReview {
  const handoff = input as unknown as ProductSalesHandoff
  const missing: string[] = []
  const risks: string[] = []
  if (handoff.artifactType !== 'product-sales-handoff') risks.push('交接 artifactType 不是 product-sales-handoff，不能按产品销售交接处理。')
  if (handoff.handoffFrom !== 'dsh-product' || handoff.handoffTo !== 'dsh-sales') risks.push('交接来源或目标不正确，避免把其他阶段材料直接当成销售交接。')
  if (handoff.schemaVersion !== '1.0') missing.push('schemaVersion must be 1.0')
  if (!text(handoff.artifactId)) missing.push('artifactId')
  for (const [field, value] of [
    ['handoffVersion', handoff.handoffVersion],
    ['productDecision', handoff.productDecision],
    ['productName', handoff.productName],
    ['targetBuyer', handoff.targetBuyer],
    ['customerProblem', handoff.customerProblem],
    ['desiredOutcome', handoff.desiredOutcome],
    ['nextCustomerAction', handoff.nextCustomerAction],
  ] as Array<[string, unknown]>) {
    if (!text(value)) missing.push(field)
  }
  if (!['proceed', 'scale'].includes(text(handoff.productDecision))) missing.push('productDecision must be proceed or scale')
  if (listField(handoff.valueEvidence).length === 0) missing.push('valueEvidence')
  if (listField(handoff.proofPoints).length === 0) missing.push('proofPoints')
  if (listField(handoff.commercialContext).length === 0) missing.push('commercialContext from dsh-business or user')
  if (!text(handoff.source)) risks.push('没有来源路径；销售团队无法回到产品决策或 PMF 证据。')
  if (listField(handoff.commercialQuestions).length > 0) risks.push(`仍有 ${listField(handoff.commercialQuestions).length} 个商业问题待确认，不能直接承诺价格或折扣。`)
  const status: ReadinessStatus = risks.some((risk) => risk.includes('不是 product-sales-handoff') || risk.includes('来源或目标不正确'))
    ? 'blocked'
    : missing.length === 0 && risks.length === 0
      ? 'ready'
      : missing.length <= 3
        ? 'partial'
        : 'blocked'
  const decision: SalesDecision = status === 'ready' ? 'advance' : status === 'partial' ? 'validate' : 'hold'
  const nextActions = status === 'ready'
    ? ['运行 sales_deal_review，补齐客户 Problem、Impact、Buyer、Process、Timing、Competition 和 Commitment。', '确认 dsh-business 的价格底线、成本基础、付款和折扣授权后再进入报价审查。']
    : ['先补齐销售交接缺失字段和商业问题，再运行 sales_deal_review；不要用缺失字段推断成交概率。']
  const normalized: ProductSalesHandoff = {
    ...handoff,
    valueEvidence: listField(handoff.valueEvidence),
    proofPoints: listField(handoff.proofPoints),
    requiredCapabilities: listField(handoff.requiredCapabilities),
    implementationConstraints: listField(handoff.implementationConstraints),
    commercialContext: listField(handoff.commercialContext),
    commercialQuestions: listField(handoff.commercialQuestions),
  }
  const productName = text(handoff.productName) || '未命名产品'
  const markdown = [
    artifactHeader('sales-handoff-review', `${productName} 产品销售交接审查`, status, { source: text(handoff.source) }),
    '## 交接判断',
    '',
    `- 决定：${decision}`,
    `- 准备度：${status}`,
    `- 产品决策：${text(handoff.productDecision) || '缺失'}`,
    '',
    '## 缺失字段',
    ...(missing.length > 0 ? missing.map((item) => `- ${item}`) : ['- 无']),
    '',
    '## 风险',
    ...(risks.length > 0 ? risks.map((item) => `- ${item}`) : ['- 未发现阻塞风险']),
    '',
    '## 下一步',
    ...nextActions.map((item) => `- ${item}`),
    '',
  ].join('\n')
  return { artifactType: 'sales-handoff-review', source: text(handoff.source) || undefined, productName, status, decision, missing, risks, handoff: normalized, warnings: [], nextActions, markdown }
}

export function reviewCommercialHandoff(input: Record<string, unknown>): CommercialHandoffReview {
  const handoff = input as unknown as BusinessCommercialHandoff
  const missing: string[] = []
  const risks = [...(Array.isArray(handoff.risks) ? handoff.risks.map((item) => text(item)).filter(Boolean) : [])]
  if (handoff.artifactType !== 'commercial-handoff') risks.push('交接 artifactType 不是 commercial-handoff。')
  if (handoff.handoffFrom !== 'dsh-business' || handoff.handoffTo !== 'dsh-sales') risks.push('商业交接来源或目标不正确。')
  if (handoff.schemaVersion !== '1.0') missing.push('schemaVersion must be 1.0')
  if (!text(handoff.artifactId)) missing.push('artifactId')
  for (const [field, value] of [['handoffVersion', handoff.handoffVersion], ['productName', handoff.productName], ['currency', handoff.currency], ['decision', handoff.decision]] as Array<[string, unknown]>) {
    if (!text(value)) missing.push(field)
  }
  if (handoff.decision !== 'review') missing.push('decision must be review')
  if (!Array.isArray(handoff.offers) || handoff.offers.length === 0) missing.push('offers')
  if (!Array.isArray(handoff.requiredApprovals) || handoff.requiredApprovals.length === 0) missing.push('requiredApprovals')
  const offers = Array.isArray(handoff.offers) ? handoff.offers : []
  for (const offer of offers) {
    if (typeof offer !== 'object' || offer === null) {
      risks.push('存在无法解析的报价行。')
      continue
    }
    const row = offer as BusinessCommercialHandoff['offers'][number]
    if (row.minimumTransactionPrice === undefined) missing.push(`minimumTransactionPrice: ${text(row.sku)}/${text(row.channel)}`)
    if (typeof row.contributionPerUnit === 'number' && row.contributionPerUnit < 0) risks.push(`${text(row.sku)}/${text(row.channel)} 单位贡献为负，不能进入正常报价。`)
    if (row.status === 'blocked') risks.push(`${text(row.sku)}/${text(row.channel)} 报价状态为 blocked。`)
  }
  if (!text(handoff.source)) risks.push('没有商业分析来源；无法回到价格或成本计算。')
  const status: ReadinessStatus = risks.some((risk) => risk.includes('不是 commercial-handoff') || risk.includes('来源或目标不正确') || risk.includes('单位贡献为负') || risk.includes('状态为 blocked'))
    ? 'blocked'
    : missing.length === 0
      ? 'ready'
      : missing.length <= 2
        ? 'partial'
        : 'blocked'
  const decision: SalesDecision = status === 'ready' ? 'advance' : status === 'partial' ? 'validate' : 'hold'
  const nextActions = status === 'ready'
    ? ['由授权负责人确认商业交接，再运行 sales_offer_review 审查客户价值、付款和折扣条件。', '任何例外价格或折扣都要回到 dsh-business 或授权审批流程。']
    : ['先补齐明确最低成交价、报价来源、审批人和风险处置，不要把有效成交价当成授权底线。']
  const normalized: BusinessCommercialHandoff = {
    ...handoff,
    offers: offers.filter((offer): offer is BusinessCommercialHandoff['offers'][number] => typeof offer === 'object' && offer !== null),
    risks,
    requiredApprovals: Array.isArray(handoff.requiredApprovals) ? handoff.requiredApprovals.map((item) => text(item)).filter(Boolean) : [],
  }
  const productName = text(handoff.productName) || '未命名产品'
  const markdown = [
    artifactHeader('commercial-handoff-review', `${productName} 商业交接审查`, status, { source: text(handoff.source) }),
    '## 交接判断',
    '',
    `- 决定：${decision}`,
    `- 准备度：${status}`,
    `- 商业决定：${text(handoff.decision) || '缺失'}`,
    '',
    '## 缺失字段',
    ...(missing.length > 0 ? missing.map((item) => `- ${item}`) : ['- 无']),
    '',
    '## 风险',
    ...(risks.length > 0 ? risks.map((item) => `- ${item}`) : ['- 未发现阻塞风险']),
    '',
    '## 下一步',
    ...nextActions.map((item) => `- ${item}`),
    '',
  ].join('\n')
  return { artifactType: 'commercial-handoff-review', source: text(handoff.source) || undefined, productName, status, decision, missing, risks, handoff: normalized, warnings: [], nextActions, markdown }
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

function field(columns: string[], preferred: string | undefined, candidates: string[]): string | undefined {
  return findField(columns, preferred, candidates)
}

function daysBetween(start: string, end: string): number | undefined {
  const from = Date.parse(start)
  const to = Date.parse(end)
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined
  return Math.max(0, Math.floor((to - from) / 86_400_000))
}

export function normalizeCrmExport(dataset: SalesDataset, mapping: Record<string, string> = {}): CrmImportResult {
  const aliases: Record<string, string[]> = {
    dealId: ['deal_id', 'opportunity_id', 'id', '商机编号'],
    stage: ['stage', 'status', '阶段', '商机阶段'],
    amount: ['amount', 'value', 'deal_value', '金额', '合同金额'],
    closeDate: ['close_date', 'expected_close', '成交日期', '预计成交日'],
    owner: ['owner', 'sales_rep', '销售负责人', '负责人'],
    outcome: ['outcome', 'result', 'win_loss', '结果', '输赢'],
    segment: ['segment', 'industry', 'customer_type', '客户分群', '行业'],
    source: ['source', 'lead_source', '来源', '渠道'],
  }
  const fieldMap: Record<string, string> = {}
  for (const [key, candidates] of Object.entries(aliases)) {
    const selected = mapping[key] ?? findField(dataset.columns, undefined, candidates)
    if (selected) fieldMap[key] = selected
  }
  const records = dataset.rows.map((row) => {
    const normalized: Record<string, Primitive | undefined> = { ...row }
    for (const [key, source] of Object.entries(fieldMap)) normalized[key] = row[source]
    return normalized
  })
  const warnings = [...dataset.warnings]
  for (const key of ['dealId', 'stage', 'amount']) if (!fieldMap[key]) warnings.push(`未识别 CRM 字段：${key}`)
  return {
    artifactType: 'sales-crm-import',
    generatedAt: new Date().toISOString(),
    source: dataset.source,
    rowsRead: dataset.rows.length,
    rowsAccepted: records.length,
    fieldMap,
    records,
    warnings,
    nextActions: warnings.length > 0 ? ['确认字段映射后再运行销售管道、阶段老化或 Win/Loss 分析。'] : ['保留原始来源和字段映射，再运行 sales_funnel_analyze 或 sales_win_loss_review。'],
  }
}

export function analyzeStageAging(dataset: SalesDataset, options: { stageField?: string; dateField?: string; asOf?: string } = {}): SalesStageAgingResult {
  const stageField = field(dataset.columns, options.stageField, ['stage', 'status', 'opportunity_stage', '阶段', '商机阶段', '状态'])
  const dateField = field(dataset.columns, options.dateField, ['created_at', 'created_date', 'stage_date', 'date', '创建日期', '阶段日期'])
  if (!stageField) throw new Error('Could not identify a stage field; provide stageField explicitly')
  if (!dateField) throw new Error('Could not identify a date field; provide dateField explicitly')
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10)
  const grouped = new Map<string, { ages: number[]; missingDate: number }>()
  for (const row of dataset.rows) {
    const stage = normalizeStage(row[stageField])
    const current = grouped.get(stage) ?? { ages: [], missingDate: 0 }
    const age = daysBetween(valueString(row[dateField]), asOf)
    if (age === undefined) current.missingDate += 1
    else current.ages.push(age)
    grouped.set(stage, current)
  }
  const stages = [...grouped.entries()].map(([stage, value]) => ({
    stage,
    records: value.ages.length + value.missingDate,
    averageAgeDays: value.ages.length > 0 ? Math.round(value.ages.reduce((sum, age) => sum + age, 0) / value.ages.length) : null,
    oldestAgeDays: value.ages.length > 0 ? Math.max(...value.ages) : null,
    missingDate: value.missingDate,
  }))
  const warnings = [...dataset.warnings]
  if (stages.some((stage) => stage.missingDate > 0)) warnings.push('部分记录缺少可解析日期，老化天数不能代表全部商机。')
  return { artifactType: 'sales-stage-aging', generatedAt: new Date().toISOString(), source: dataset.source, asOf, stageField, dateField, stages, warnings, nextActions: ['优先检查平均或最老停留时间最高的阶段，并结合客户下一步动作复核。'] }
}

export function reviewWinLoss(dataset: SalesDataset, options: { outcomeField?: string; amountField?: string; segmentField?: string; reasonField?: string } = {}): SalesWinLossResult {
  const outcomeField = field(dataset.columns, options.outcomeField, ['outcome', 'result', 'win_loss', 'status', '结果', '输赢'])
  const amountField = field(dataset.columns, options.amountField, ['amount', 'value', 'deal_value', '金额', '合同金额'])
  const segmentField = field(dataset.columns, options.segmentField, ['segment', 'industry', 'customer_type', '客户分群', '行业'])
  const reasonField = field(dataset.columns, options.reasonField, ['loss_reason', 'reason', 'unmet_need', '失单原因', '原因', '未满足需求'])
  if (!outcomeField) throw new Error('Could not identify an outcome field; provide outcomeField explicitly')
  const groups = new Map<string, { won: number; lost: number; wonAmount: number; lostAmount: number }>()
  const reasons = new Map<string, number>()
  let won = 0; let lost = 0; let wonAmount = 0; let lostAmount = 0
  for (const row of dataset.rows) {
    const outcome = valueString(row[outcomeField]).toLowerCase()
    const isWon = ['won', 'closed-won', 'win', '赢单', '成交', '成功'].includes(outcome)
    const isLost = ['lost', 'closed-lost', 'loss', '输单', '失单', '失败'].includes(outcome)
    if (!isWon && !isLost) continue
    const amount = numberValue(amountField ? row[amountField] : undefined) ?? 0
    const segment = segmentField ? valueString(row[segmentField]) || '未分群' : '全部'
    const current = groups.get(segment) ?? { won: 0, lost: 0, wonAmount: 0, lostAmount: 0 }
    if (isWon) { won += 1; wonAmount += amount; current.won += 1; current.wonAmount += amount }
    if (isLost) {
      lost += 1; lostAmount += amount; current.lost += 1; current.lostAmount += amount
      const reason = reasonField ? valueString(row[reasonField]) : ''
      if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    }
    groups.set(segment, current)
  }
  const segments = [...groups.entries()].map(([segment, value]) => ({ segment, ...value, winRate: value.won + value.lost > 0 ? Math.round((value.won / (value.won + value.lost)) * 1000) / 10 : null }))
  const feedback = [...reasons.entries()].map(([reason, count]) => ({ target: /功能|产品|缺少|集成|体验/i.test(reason) ? 'dsh-product' as const : 'dsh-idea' as const, reason, count })).sort((a, b) => b.count - a.count)
  return { artifactType: 'sales-win-loss-review', generatedAt: new Date().toISOString(), source: dataset.source, outcomeField, ...(amountField ? { amountField } : {}), ...(segmentField ? { segmentField } : {}), summary: { won, lost, winRate: won + lost > 0 ? Math.round((won / (won + lost)) * 1000) / 10 : null, wonAmount, lostAmount }, segments, feedback, warnings: [...dataset.warnings, ...(won + lost < dataset.rows.length ? ['部分记录没有可识别的赢输结果，未纳入胜率。'] : [])], nextActions: feedback.length > 0 ? ['将高频失单原因分别交给 dsh-product 或 dsh-idea，形成产品变更或新发现。'] : ['补充失单原因字段，再分析可行动的反馈回流。'] }
}

function artifactSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'unknown'
}

export function buildSalesFeedbackHandoff(input: {
  dataset: SalesDataset
  target: 'dsh-product' | 'dsh-idea' | 'dsh-growth'
  options?: { outcomeField?: string; amountField?: string; segmentField?: string; reasonField?: string }
}): SalesFeedbackHandoff {
  const review = reviewWinLoss(input.dataset, input.options)
  const generatedAt = new Date().toISOString()
  const artifactId = `dsh-sales-feedback-${input.target}-${artifactSlug(input.dataset.source)}-${generatedAt.slice(0, 10)}`
  const feedback = input.target === 'dsh-growth'
    ? review.feedback
    : review.feedback.filter((item) => item.target === input.target)
  const warnings = [...review.warnings]
  if (feedback.length === 0) warnings.push(`没有明确归属 ${input.target} 的输赢反馈；请补充失单原因或人工分类。`)
  const nextActions = input.target === 'dsh-product'
    ? ['由 dsh-product 评估是否形成产品变更影响审查，不把单一失单原因当作普遍需求。']
    : input.target === 'dsh-idea'
      ? ['由 dsh-idea 将重复且有证据的市场问题转成新发现，再安排最小验证实验。']
      : ['由 dsh-growth 将成交与失单结果映射到收入、转化和回收期指标，保留原始来源。']
  const handoff: SalesFeedbackHandoff = {
    schemaVersion: '1.0',
    artifactId,
    artifactType: 'sales-feedback-handoff',
    handoffFrom: 'dsh-sales',
    handoffTo: input.target,
    generatedAt,
    source: input.dataset.source,
    target: input.target,
    summary: review.summary,
    segments: review.segments,
    feedback,
    warnings,
    nextActions,
    markdown: '',
  }
  handoff.markdown = [
    '---',
    'schemaVersion: "1.0"',
    `artifactId: ${JSON.stringify(artifactId)}`,
    'artifactType: sales-feedback-handoff',
    'handoffFrom: dsh-sales',
    `handoffTo: ${input.target}`,
    `generatedAt: ${generatedAt}`,
    `source: ${JSON.stringify(input.dataset.source)}`,
    '---',
    '# 销售反馈回流',
    '',
    `- 回流目标：${input.target}`,
    `- 赢单：${review.summary.won}`,
    `- 输单：${review.summary.lost}`,
    `- 胜率：${review.summary.winRate === null ? '缺失' : `${review.summary.winRate}%`}`,
    '',
    '## 可行动反馈',
    ...(feedback.length > 0 ? feedback.map((item) => `- ${item.reason}：${item.count} 次`) : ['- 无；需要补充原因或人工分类。']),
    '',
    '## 下一步',
    ...nextActions.map((item) => `- ${item}`),
    '',
  ].join('\n')
  return handoff
}
