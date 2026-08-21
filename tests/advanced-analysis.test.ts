import { describe, expect, it } from 'vitest'
import { analyzeStageAging, normalizeCrmExport, reviewWinLoss } from '../src/sales.js'
import type { SalesDataset } from '../src/types.js'

const dataset: SalesDataset = {
  source: 'crm.csv',
  columns: ['id', 'stage', 'created_date', 'outcome', 'amount', 'segment', 'loss_reason'],
  rows: [
    { id: '1', stage: 'proposal', created_date: '2026-08-01', outcome: 'won', amount: 100, segment: 'SMB' },
    { id: '2', stage: 'negotiation', created_date: '2026-07-01', outcome: 'lost', amount: 80, segment: 'SMB', loss_reason: '缺少导出能力' },
  ],
  warnings: [],
}

describe('sales operational analysis', () => {
  it('normalizes CRM fields without changing the source rows', () => {
    const result = normalizeCrmExport(dataset)
    expect(result.fieldMap.dealId).toBe('id')
    expect(result.records[0]?.dealId).toBe('1')
  })

  it('reports stage aging with an explicit boundary', () => {
    const result = analyzeStageAging(dataset, { asOf: '2026-08-21' })
    expect(result.stages.find((stage) => stage.stage === 'proposal')?.averageAgeDays).toBe(20)
  })

  it('returns win-loss cohorts and product feedback targets', () => {
    const result = reviewWinLoss(dataset)
    expect(result.summary.winRate).toBe(50)
    expect(result.feedback[0]?.target).toBe('dsh-product')
  })
})
