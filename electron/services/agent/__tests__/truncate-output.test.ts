/**
 * exec 输出截断 helper 单元测试
 */
import { describe, it, expect } from 'vitest'
import {
  truncateFromEndDetailed,
  truncateFromEndWithNotice,
  truncateSandwichDetailed,
  truncateSandwichWithNotice,
} from '../tools/utils'

describe('truncateFromEndDetailed', () => {
  it('短文本不截断', () => {
    const result = truncateFromEndDetailed('hello', 100)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe('hello')
  })

  it('超长文本截断并保留尾部', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`)
    const input = lines.join('\n')
    const result = truncateFromEndDetailed(input, 100)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('line-199')
    expect(result.text).not.toContain('line-0\n')
  })
})

describe('truncateFromEndWithNotice', () => {
  it('未截断时不附加 notice', () => {
    const out = truncateFromEndWithNotice('ok', 10, () => 'NOTICE')
    expect(out).toBe('ok')
  })
})

describe('truncateSandwichDetailed', () => {
  it('短文本不截断', () => {
    const result = truncateSandwichDetailed('hello', 100)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe('hello')
  })

  it('多行输出同时保留开头与末尾行', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${String(i).padStart(3, '0')}`)
    const input = lines.join('\n')
    const result = truncateSandwichDetailed(input, 800)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('line-000')
    expect(result.text).toContain('line-499')
    expect(result.text).toContain('\n...\n')
    expect(result.omittedLines).toBeGreaterThan(0)
    expect(result.omittedChars).toBeGreaterThan(0)
  })

  it('单行超长内容按字符头尾截断', () => {
    const input = 'a'.repeat(500) + 'MARKER' + 'z'.repeat(500)
    const result = truncateSandwichDetailed(input, 200)
    expect(result.truncated).toBe(true)
    expect(result.text.startsWith('aaa')).toBe(true)
    expect(result.text.endsWith('zzz')).toBe(true)
    expect(result.text).toContain('\n...\n')
    expect(result.omittedLines).toBe(0)
    expect(result.omittedChars).toBeGreaterThan(0)
  })

  it('含一条超长行时行内截断而不撑爆预算', () => {
    const short = Array.from({ length: 5 }, (_, i) => `short-${i}`)
    const longLine = 'L'.repeat(10_000)
    const input = [...short, longLine, 'tail-line'].join('\n')
    const result = truncateSandwichDetailed(input, 600)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('short-0')
    expect(result.text).toContain('tail-line')
    expect(result.shownLength).toBeLessThanOrEqual(600)
  })
})

describe('truncateSandwichWithNotice', () => {
  it('截断时附加 notice 行', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `row-${i}`)
    const input = lines.join('\n')
    const out = truncateSandwichWithNotice(input, 120, (s) =>
      `[total=${s.originalLength} head=${s.headChars} tail=${s.tailChars}]`
    )
    expect(out.startsWith('[total=')).toBe(true)
    expect(out).toContain('row-0')
    expect(out).toContain('row-99')
  })
})
