import { describe, it, expect, vi } from 'vitest'
import { normalizeWhenToUse, suggestMcpWhenToUse } from '../mcp-when-to-use'

describe('normalizeWhenToUse', () => {
  it('trims and strips wrapping quotes', () => {
    expect(normalizeWhenToUse('  「查企业」  ')).toBe('查企业')
    expect(normalizeWhenToUse('"hello"')).toBe('hello')
  })

  it('caps length at 200', () => {
    const long = '字'.repeat(250)
    expect(normalizeWhenToUse(long).length).toBe(200)
  })
})

describe('suggestMcpWhenToUse', () => {
  it('returns draft from chat', async () => {
    const chat = vi.fn().mockResolvedValue('查询企业工商数据，勿用网页搜索代替')
    const result = await suggestMcpWhenToUse(chat, {
      name: '企查查',
      tools: [{ name: 'search', description: '搜企业' }]
    })
    expect(result.success).toBe(true)
    expect(result.whenToUse).toContain('企业')
    expect(chat).toHaveBeenCalledOnce()
  })

  it('fails on empty name', async () => {
    const result = await suggestMcpWhenToUse(async () => 'x', { name: '  ', tools: [] })
    expect(result.success).toBe(false)
  })

  it('fails when chat throws', async () => {
    const result = await suggestMcpWhenToUse(async () => {
      throw new Error('no profile')
    }, { name: 'x', tools: [] })
    expect(result.success).toBe(false)
    expect(result.error).toContain('no profile')
  })
})
