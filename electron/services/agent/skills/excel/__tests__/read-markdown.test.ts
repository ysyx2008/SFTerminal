import { describe, expect, it } from 'vitest'
import { buildReadRangeMarkdownTable } from '../read-markdown'

describe('buildReadRangeMarkdownTable', () => {
  it('does not duplicate the first data row as header', () => {
    const md = buildReadRangeMarkdownTable(
      2,
      ['A', 'B'],
      [['序号', '说明'], ['1', '甲'], ['2', '乙']],
      '行号',
      'Excel 行号 2–4'
    )

    const lines = md.trim().split('\n')
    expect(lines[2]).toBe('| 行号 | A | B |')
    expect(lines[4]).toBe('| 2 | 序号 | 说明 |')
    expect(lines[5]).toBe('| 3 | 1 | 甲 |')
    expect(lines[6]).toBe('| 4 | 2 | 乙 |')
    // 表头行不应再作为单独的数据行重复出现
    expect(lines.filter(l => l === '| 2 | 序号 | 说明 |')).toHaveLength(1)
  })
})
