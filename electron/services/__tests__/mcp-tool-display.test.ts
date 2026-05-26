import { describe, expect, it } from 'vitest'
import { resolveMcpToolDisplayLabel } from '../mcp-tool-display'

describe('resolveMcpToolDisplayLabel', () => {
  it('优先使用 title', () => {
    expect(resolveMcpToolDisplayLabel({
      name: 'get_qualifications',
      title: '获取企业资质',
      description: '查询企业资质信息'
    })).toBe('获取企业资质')
  })

  it('无 title 时使用 description 首行', () => {
    expect(resolveMcpToolDisplayLabel({
      name: 'get_credit_evaluation',
      description: '获取企业信用评价\n详细说明…'
    })).toBe('获取企业信用评价')
  })

  it('description 过长时回退到格式化英文名', () => {
    expect(resolveMcpToolDisplayLabel({
      name: 'get_bidding_info',
      description: 'A'.repeat(100)
    })).toBe('Get Bidding Info')
  })

  it('无元数据时格式化 snake_case 名称', () => {
    expect(resolveMcpToolDisplayLabel({ name: 'get_news_sentiment' }))
      .toBe('Get News Sentiment')
  })
})
