import { describe, it, expect } from 'vitest'
import {
  renderExcelWorkbookPreviewHtml,
  type PreviewWorksheet
} from '../preview-html'

function sheet(
  name: string,
  rows: unknown[][],
  extras?: { rowCount?: number; columnCount?: number }
): PreviewWorksheet {
  return {
    name,
    rowCount: extras?.rowCount ?? rows.length,
    columnCount: extras?.columnCount ?? (rows[0]?.length ?? 0),
    eachRow(_opts, cb) {
      rows.forEach((vals, i) => {
        cb({
          eachCell(_cOpts, cellCb) {
            vals.forEach((value, j) => cellCb({ value }, j + 1))
          }
        }, i + 1)
      })
    }
  }
}

describe('renderExcelWorkbookPreviewHtml', () => {
  it('空工作簿', () => {
    expect(renderExcelWorkbookPreviewHtml([])).toBe('<p><em>(空工作簿)</em></p>')
  })

  it('单表不渲染切表标签', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('Sheet1', [['A', 'B'], [1, 2]])
    ])
    expect(html).toContain('data-sheet="Sheet1"')
    expect(html).toContain('>A<')
    expect(html).not.toContain('sheet-tabs')
    expect(html).not.toContain(' hidden')
  })

  it('多表默认展示第一张，其余隐藏，底部可切', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('收入', [['x']]),
      sheet('支出', [['y']])
    ])
    expect(html).toContain('sheet-tabs')
    expect(html).toContain('data-sheet="收入"')
    expect(html).toContain('data-sheet="支出"')
    expect(html).toMatch(/sheet-pane" data-sheet="收入">/)
    expect(html).toMatch(/sheet-pane" data-sheet="支出" hidden>/)
    expect(html).toContain('sheet-tab active')
    expect(html).toContain('>x<')
    expect(html).toContain('>y<')
  })

  it('指定 activeSheet 时停在那张', () => {
    const html = renderExcelWorkbookPreviewHtml(
      [sheet('收入', [['x']]), sheet('支出', [['y']])],
      { activeSheet: '支出' }
    )
    expect(html).toMatch(/sheet-pane" data-sheet="收入" hidden>/)
    expect(html).toMatch(/sheet-pane" data-sheet="支出">/)
    expect(html).toContain('data-sheet="支出">支出</span>')
  })

  it('空表仍保留 pane，方便切走', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('空表', [], { rowCount: 0, columnCount: 0 }),
      sheet('有数', [['ok']])
    ])
    expect(html).toContain('(空工作表)')
    expect(html).toContain('sheet-tabs')
  })

  it('高亮只落在当前展示的表', () => {
    const html = renderExcelWorkbookPreviewHtml(
      [sheet('A', [[1]]), sheet('B', [[2]])],
      { activeSheet: 'A', highlights: { modified: new Set(['1,1']) } }
    )
    const paneA = html.slice(html.indexOf('data-sheet="A"'), html.indexOf('data-sheet="B"'))
    const paneB = html.slice(html.indexOf('data-sheet="B"'))
    expect(paneA).toContain('class="num modified"')
    expect(paneB).not.toContain('modified')
  })
})
