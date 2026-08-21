export type Primitive = string | number | boolean | null
export type Row = Record<string, Primitive | undefined>

export type EvidenceStatus = 'observed' | 'customer-stated' | 'estimated' | 'inferred' | 'missing'
export type ReadinessStatus = 'ready' | 'partial' | 'blocked' | 'not-detected' | 'not-applicable'
export type SalesDecision = 'advance' | 'validate' | 'hold' | 'disqualify' | 'expand'
export type DealStage = 'lead' | 'qualified' | 'discovery' | 'solution' | 'proposal' | 'negotiation' | 'closed-won' | 'closed-lost' | 'renewal' | 'expansion'

export interface SalesConfig {
  defaultRoot: string
  reportDir: string
  maxFiles: number
  maxRows: number
  maxFileBytes: number
  maxTextChars: number
  maxResultChars: number
  defaultCurrency: string
  defaultTimezone: string
}

export interface FileSystemLike {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
  contains(parent: unknown, child: unknown): boolean
  stat(target: unknown, signal?: AbortSignal): Promise<{ type: string; size?: number; version: unknown } | undefined>
  readText(target: unknown, signal?: AbortSignal): Promise<string>
  listDir(target: unknown, signal?: AbortSignal): Promise<Array<{ name: string; type: string; target: unknown; size?: number }>>
  writeText(target: unknown, content: string, expected?: unknown, signal?: AbortSignal): Promise<unknown>
}

export interface SalesDataset {
  source: string
  rows: Row[]
  columns: string[]
  warnings: string[]
}

export interface SalesNote {
  path: string
  title: string
  content: string
  frontmatter: Record<string, unknown>
  headings: string[]
  externalLinks: string[]
  wordCount: number
}

export interface SalesScanResult {
  root: string
  generatedAt: string
  scannedFiles: number
  skippedFiles: number
  errors: string[]
  summary: {
    salesNotes: number
    dataFiles: number
    missingMetadata: number
    staleNotes: number
    missingSources: number
    byType: Record<string, number>
    byStatus: Record<string, number>
  }
  priorityFiles: Array<{ path: string; title: string; type: string; status: string; reasons: string[] }>
}

export interface SalesOnboardingResult {
  generatedAt: string
  root: string
  overallStatus: 'ready' | 'partial' | 'blocked'
  overallScore: number
  dimensions: Array<{
    id: string
    label: string
    status: ReadinessStatus
    score: number | null
    evidence: string[]
    missing: string[]
    nextAction: string
  }>
  methods: Array<{ id: string; name: string; status: ReadinessStatus; evidence: string[]; nextAction: string }>
  currentStep: 'context' | 'qualification' | 'pipeline' | 'commercial' | 'close' | 'expansion'
  topActions: string[]
  warnings: string[]
}

export interface FunnelAnalysis {
  source: string
  stageField: string
  amountField?: string
  dateField?: string
  stages: Array<{ stage: string; records: number; amount: number; conversionFromPrevious: number | null; shareOfPipeline: number | null }>
  totals: { records: number; amount: number; weightedAmount: number }
  missing: string[]
  warnings: string[]
  nextActions: string[]
}

export interface DealReviewResult {
  deal: string
  decision: SalesDecision
  readiness: ReadinessStatus
  score: number
  evidence: Array<{ dimension: string; status: EvidenceStatus; value: string; source?: string }>
  missing: string[]
  risks: string[]
  nextActions: string[]
  assumptions: string[]
  markdown: string
}

export interface OfferReviewResult {
  offer: string
  decision: 'approve-for-review' | 'revise' | 'blocked'
  readiness: ReadinessStatus
  valueEvidence: string[]
  commercialFacts: Array<{ field: string; status: EvidenceStatus; value: string }>
  risks: string[]
  missing: string[]
  nextActions: string[]
  markdown: string
}

export interface ForecastResult {
  source: string
  currency: string
  asOf: string
  records: number
  rawAmount: number
  weightedAmount: number
  byStage: Array<{ stage: string; records: number; amount: number; probability: number; weightedAmount: number }>
  missingAmount: number
  missingCloseDate: number
  staleRecords: number
  warnings: string[]
  assumptions: string[]
  nextActions: string[]
}

export interface GeneratedArtifact {
  artifactType: 'sales-playbook' | 'deal-review' | 'pipeline-review' | 'offer-review'
  title: string
  status: 'draft' | 'ready-for-review'
  source?: string
  markdown: string
  nextActions: string[]
}

export interface ProductSalesHandoff {
  handoffVersion: string
  artifactType: 'product-sales-handoff'
  handoffFrom: 'dsh-product'
  handoffTo: 'dsh-sales'
  generatedAt: string
  status: 'ready' | 'partial'
  productDecision: 'proceed' | 'scale'
  productName: string
  targetBuyer: string
  customerProblem: string
  desiredOutcome: string
  valueEvidence: string[]
  proofPoints: string[]
  requiredCapabilities: string[]
  implementationConstraints: string[]
  commercialContext: string[]
  commercialQuestions: string[]
  nextCustomerAction: string
  owner?: string
  source?: string
}

export interface ProductSalesHandoffReview {
  artifactType: 'sales-handoff-review'
  source?: string
  productName: string
  status: ReadinessStatus
  decision: SalesDecision
  missing: string[]
  risks: string[]
  handoff: ProductSalesHandoff
  warnings: string[]
  nextActions: string[]
  markdown: string
}
