// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  a1Range,
  applySpreadsheetSelection,
  cellAddress,
  cellFromTarget,
  columnLetter,
  expandRectToSpans,
  formatSpreadsheetExcerpt,
  normalizeRect,
  readSelectedCells,
  rectsIntersect,
  SPREADSHEET_EXCERPT_CELL_CAP,
  SPREADSHEET_SELECTED_CLASS
} from '../domain/spreadsheet-selection'

describe('spreadsheet-selection 坐标', () => {
  it('列字母与 A1 地址', () => {
    expect(columnLetter(1)).toBe('A')
    expect(columnLetter(26)).toBe('Z')
    expect(columnLetter(27)).toBe('AA')
    expect(cellAddress(3, 2)).toBe('B3')
    expect(a1Range({ top: 1, left: 1, bottom: 1, right: 1 })).toBe('A1')
    expect(a1Range({ top: 2, left: 2, bottom: 4, right: 3 })).toBe('B2:C4')
  })

  it('两点拖成矩形，与合并区相交时扩到整块', () => {
    expect(normalizeRect(
      { top: 3, left: 3, bottom: 3, right: 3 },
      { top: 1, left: 1, bottom: 1, right: 1 }
    )).toEqual({ top: 1, left: 1, bottom: 3, right: 3 })

    const expanded = expandRectToSpans(
      { top: 1, left: 1, bottom: 1, right: 1 },
      [{ row: 1, col: 1, rowspan: 1, colspan: 3 }]
    )
    expect(expanded).toEqual({ top: 1, left: 1, bottom: 1, right: 3 })
    expect(rectsIntersect(
      { top: 1, left: 1, bottom: 2, right: 2 },
      { top: 2, left: 2, bottom: 3, right: 3 }
    )).toBe(true)
  })
})

describe('formatSpreadsheetExcerpt', () => {
  it('写明表名、范围和格子现值', () => {
    const text = formatSpreadsheetExcerpt({
      sheet: '收入',
      rect: { top: 1, left: 1, bottom: 2, right: 2 },
      cells: [
        { address: 'A1', value: '标题' },
        { address: 'B2', value: '10' }
      ]
    })
    expect(text).toContain('Sheet: 收入')
    expect(text).toContain('Range: A1:B2')
    expect(text).toContain('A1: 标题')
    expect(text).toContain('B2: 10')
  })

  it('格子太多时截断并标明还有多少', () => {
    const cells = Array.from({ length: SPREADSHEET_EXCERPT_CELL_CAP + 5 }, (_, i) => ({
      address: `A${i + 1}`,
      value: String(i)
    }))
    const text = formatSpreadsheetExcerpt({
      sheet: 'Sheet1',
      rect: { top: 1, left: 1, bottom: cells.length, right: 1 },
      cells
    })
    expect(text).toContain('… (5 more cells)')
    expect(text.split('\n').filter(l => l.startsWith('A')).length).toBe(SPREADSHEET_EXCERPT_CELL_CAP)
  })
})

describe('spreadsheet-selection DOM', () => {
  it('按 data-r/data-c 高亮并读出格子', () => {
    const pane = document.createElement('div')
    pane.className = 'sheet-pane'
    pane.innerHTML = `
      <table>
        <tr>
          <td data-r="1" data-c="1">标题</td>
          <td data-r="1" data-c="2">数量</td>
        </tr>
        <tr>
          <td data-r="2" data-c="1">苹果</td>
          <td data-r="2" data-c="2">10</td>
        </tr>
      </table>
    `
    const rect = { top: 2, left: 1, bottom: 2, right: 2 }
    applySpreadsheetSelection(pane, rect)
    expect(pane.querySelector('[data-r="2"][data-c="1"]')?.classList.contains(SPREADSHEET_SELECTED_CLASS)).toBe(true)
    expect(pane.querySelector('[data-r="1"][data-c="1"]')?.classList.contains(SPREADSHEET_SELECTED_CLASS)).toBe(false)
    expect(readSelectedCells(pane, rect)).toEqual([
      { address: 'A2', value: '苹果' },
      { address: 'B2', value: '10' }
    ])
    const start = cellFromTarget(pane.querySelector('[data-r="1"][data-c="2"]'), pane)
    expect(start).toMatchObject({ row: 1, col: 2 })
    expect(cellFromTarget(pane, pane)).toBeNull()
  })
})
