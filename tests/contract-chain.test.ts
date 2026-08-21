import { describe, expect, it } from 'vitest'
import { buildSalesFeedbackHandoff } from '../src/sales.js'
import type { SalesDataset } from '../src/types.js'

const dataset: SalesDataset = {
  source: 'crm.csv',
  columns: ['outcome', 'amount', 'segment', 'reason'],
  rows: [
    { outcome: 'won', amount: 100, segment: 'SMB' },
    { outcome: 'lost', amount: 80, segment: 'SMB', reason: '市场需求不明确' },
  ],
  warnings: [],
}

describe('cross-plugin contract smoke chain', () => {
  it('returns a versioned sales feedback artifact for the idea loop', () => {
    const handoff = buildSalesFeedbackHandoff({ dataset, target: 'dsh-idea', options: { outcomeField: 'outcome', amountField: 'amount', segmentField: 'segment', reasonField: 'reason' } })
    expect(handoff.schemaVersion).toBe('1.0')
    expect(handoff.artifactId).toContain('dsh-sales-feedback-dsh-idea')
    expect(handoff.handoffFrom).toBe('dsh-sales')
    expect(handoff.handoffTo).toBe('dsh-idea')
    expect(handoff.feedback[0]?.reason).toBe('市场需求不明确')
  })
})
