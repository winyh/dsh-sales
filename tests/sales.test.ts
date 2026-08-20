import { describe, expect, it } from 'vitest'
import { analyzeSalesFunnel, forecastPipeline, reviewDeal, reviewOffer } from '../src/sales.js'
import type { SalesDataset } from '../src/types.js'

function dataset(rows: SalesDataset['rows']): SalesDataset {
  return { source: 'pipeline.csv', rows, columns: [...new Set(rows.flatMap((row) => Object.keys(row)))], warnings: [] }
}

describe('sales methods', () => {
  it('maps Chinese stages and calculates funnel totals', () => {
    const result = analyzeSalesFunnel(dataset([
      { 阶段: '资格', 金额: 100 },
      { 阶段: '方案', 金额: 200 },
      { 阶段: '成交', 金额: 300 },
    ]), { stageField: '阶段', amountField: '金额' })
    expect(result.stages.map((stage) => stage.stage)).toEqual(['qualified', 'solution', 'closed-won'])
    expect(result.totals.amount).toBe(600)
    expect(result.totals.weightedAmount).toBe(395)
  })

  it('keeps missing qualification evidence as a validation decision', () => {
    const result = reviewDeal('ACME', {
      problem: { value: '手工报表耗时', status: 'customer-stated' },
      impact: { value: '每周节省 10 小时', status: 'estimated' },
      buyer: { value: '业务负责人', status: 'customer-stated' },
    })
    expect(result.decision).toBe('hold')
    expect(result.missing).toContain('Process')
    expect(result.markdown).toContain('商机复盘')
  })

  it('shows stale and missing fields in a weighted forecast', () => {
    const result = forecastPipeline(dataset([
      { stage: 'proposal', amount: 100, expected_close: '2020-01-01' },
      { stage: 'discovery', amount: 'bad', expected_close: '' },
    ]), { currency: 'CNY', asOf: '2026-08-20' })
    expect(result.weightedAmount).toBe(60)
    expect(result.missingAmount).toBe(1)
    expect(result.staleRecords).toBe(1)
    expect(result.missingCloseDate).toBe(1)
  })

  it('blocks an offer without commercial authorization', () => {
    const result = reviewOffer('Starter', { valueEvidence: ['客户预计减少 20% 人工处理时间'], facts: { targetCustomer: '财务团队', problem: '月结慢' } })
    expect(result.decision).toBe('blocked')
    expect(result.missing).toContain('报价来源')
    expect(result.markdown).toContain('报价与变现审查')
  })
})
