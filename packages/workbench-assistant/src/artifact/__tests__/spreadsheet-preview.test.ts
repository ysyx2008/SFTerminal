// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  applySpreadsheetActiveSheet,
  parseSpreadsheetPreviewHtml,
  spreadsheetPreviewNeedsAllSheets
} from '../domain/spreadsheet-preview'

describe('parseSpreadsheetPreviewHtml', () => {
  it('新格式：读出全部 pane，默认停在未 hidden 的表', () => {
    const model = parseSpreadsheetPreviewHtml(`
      <div class="sheet-pane" data-sheet="收入"><table>a</table></div>
      <div class="sheet-pane" data-sheet="支出" hidden><table>b</table></div>
      <div class="sheet-tabs">
        <span class="sheet-tab active" data-sheet="收入">收入</span>
        <span class="sheet-tab" data-sheet="支出">支出</span>
      </div>
    `)
    expect(model.sheets.map(s => s.name)).toEqual(['收入', '支出'])
    expect(model.activeSheet).toBe('收入')
    expect(model.sheets[0].html).toContain('a')
    expect(model.sheets[1].html).toContain('b')
    expect(spreadsheetPreviewNeedsAllSheets(model)).toBe(false)
  })

  it('旧格式：只有当前表 HTML，其余表空，需要重建', () => {
    const model = parseSpreadsheetPreviewHtml(`
      <table><tr><td>only-sheet1</td></tr></table>
      <div class="sheet-tabs">
        <span class="sheet-tab active">Sheet1</span>
        <span class="sheet-tab">Sheet2</span>
        <span class="sheet-tab">Sheet3</span>
      </div>
    `)
    expect(model.sheets.map(s => s.name)).toEqual(['Sheet1', 'Sheet2', 'Sheet3'])
    expect(model.activeSheet).toBe('Sheet1')
    expect(model.sheets[0].html).toContain('only-sheet1')
    expect(model.sheets[0].html).not.toContain('sheet-tabs')
    expect(model.sheets[1].html).toBe('')
    expect(spreadsheetPreviewNeedsAllSheets(model)).toBe(true)
  })

  it('单表无标签', () => {
    const model = parseSpreadsheetPreviewHtml('<table><tr><td>x</td></tr></table>')
    expect(model.sheets).toHaveLength(1)
    expect(model.sheets[0].name).toBe('')
    expect(model.sheets[0].html).toContain('x')
    expect(spreadsheetPreviewNeedsAllSheets(model)).toBe(false)
  })
})

describe('applySpreadsheetActiveSheet', () => {
  it('显示目标 pane，其余隐藏', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div class="sheet-pane" data-sheet="Sheet1"><table>1</table></div>
      <div class="sheet-pane" data-sheet="Sheet2" hidden><table>2</table></div>
    `
    expect(applySpreadsheetActiveSheet(root, 'Sheet2')).toBe(true)
    const panes = [...root.querySelectorAll<HTMLElement>('.sheet-pane')]
    expect(panes[0].hidden).toBe(true)
    expect(panes[1].hidden).toBe(false)
    expect(panes[1].textContent).toContain('2')
  })
})
