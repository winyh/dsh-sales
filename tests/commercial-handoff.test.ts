import { describe, expect, it } from 'vitest'
import { reviewCommercialHandoff } from '../src/sales.js'

const handoff = {
  handoffVersion: '1.0',
  artifactType: 'commercial-handoff',
  handoffFrom: 'dsh-business',
  handoffTo: 'dsh-sales',
  generatedAt: '2026-08-21T00:00:00.000Z',
  status: 'ready-for-review',
  decision: 'review',
  productName: 'Example',
  currency: 'CNY',
  offers: [{ sku: 'A', channel: 'direct', effectivePrice: 100, minimumTransactionPrice: 80, unitCost: 40, contributionPerUnit: 60, contributionMarginPct: 60, status: 'healthy' }],
  risks: [],
  requiredApprovals: ['确认最低成交价和折扣授权'],
  source: 'pricing-review.md',
}

describe('commercial handoff review', () => {
  it('accepts explicit commercial facts for review', () => {
    const review = reviewCommercialHandoff(handoff)
    expect(review.status).toBe('ready')
    expect(review.decision).toBe('advance')
  })

  it('blocks an offer without an explicit price floor', () => {
    const review = reviewCommercialHandoff({ ...handoff, offers: [{ ...handoff.offers[0], minimumTransactionPrice: undefined }] })
    expect(review.status).toBe('partial')
    expect(review.missing[0]).toContain('minimumTransactionPrice')
  })
})
