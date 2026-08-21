import { describe, expect, it } from 'vitest'
import { reviewProductSalesHandoff } from '../src/sales.js'

const handoff = {
  schemaVersion: '1.0',
  artifactId: 'dsh-product-sales-example-2026-08-21',
  handoffVersion: '1.0',
  artifactType: 'product-sales-handoff',
  handoffFrom: 'dsh-product',
  handoffTo: 'dsh-sales',
  generatedAt: '2026-08-21T00:00:00.000Z',
  status: 'ready',
  productDecision: 'proceed',
  productName: 'Example',
  targetBuyer: '运营负责人',
  customerProblem: '交付不可追踪',
  desiredOutcome: '及时定位阻塞',
  valueEvidence: ['试点结果'],
  proofPoints: ['定位时间下降'],
  requiredCapabilities: ['数据导入'],
  implementationConstraints: ['不改 CRM'],
  commercialContext: ['dsh-business 价格底线已确认'],
  commercialQuestions: [],
  nextCustomerAction: '客户确认试点范围',
  source: 'pmf-review.md',
}

describe('product sales handoff review', () => {
  it('accepts a complete handoff', () => {
    const review = reviewProductSalesHandoff(handoff)
    expect(review.status).toBe('ready')
    expect(review.decision).toBe('advance')
    expect(review.handoff.commercialContext).toHaveLength(1)
  })

  it('holds a handoff without commercial context', () => {
    const review = reviewProductSalesHandoff({ ...handoff, commercialContext: [], valueEvidence: [] })
    expect(review.status).toBe('partial')
    expect(review.missing).toContain('commercialContext from dsh-business or user')
  })
})
