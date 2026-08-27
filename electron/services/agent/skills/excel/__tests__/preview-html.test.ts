import { describe, it, expect } from 'vitest'
import {
  previewTableExtent,
  renderExcelWorkbookPreviewHtml,
  type PreviewWorksheet
} from '../preview-html'

function sheet(
  name: string,
  rows: unknown[][],
  extras?: { rowCount?: number; columnCount?: number; merges?: PreviewWorksheet['merges'] }
): PreviewWorksheet {
  return {
    name,
    rowCount: extras?.rowCount ?? rows.length,
    columnCount: extras?.columnCount ?? (rows[0]?.length ?? 0),
    merges: extras?.merges,
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

describe('previewTableExtent', () => {
  it('普通表按实际大小，不截', () => {
    expect(previewTableExtent(120, 25)).toEqual({ rows: 120, cols: 25 })
    expect(previewTableExtent(0, 0)).toEqual({ rows: 0, cols: 0 })
  })

  it('超大表才截到不卡的上限', () => {
    expect(previewTableExtent(8000, 10)).toEqual({ rows: 5000, cols: 10 })
    expect(previewTableExtent(20, 200)).toEqual({ rows: 20, cols: 150 })
    expect(previewTableExtent(2000, 80)).toEqual({ rows: 1000, cols: 80 })
  })
})

describe('renderExcelWorkbookPreviewHtml', () => {
  it('空工作簿', () => {
    expect(renderExcelWorkbookPreviewHtml([])).toContain('这份工作簿是空的')
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

  it('空表仍保留 pane，并写明是空的', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('空表', [], { rowCount: 0, columnCount: 0 }),
      sheet('有数', [['ok']])
    ])
    expect(html).toContain('class="sheet-empty"')
    expect(html).toContain('这张表是空的')
    expect(html).toContain('sheet-tabs')
    expect(html).toContain('data-sheet="空表"')
  })

  it('只有空格子的表也写明是空的，不画一片空白格', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('空白', [['', ''], ['', '']], { rowCount: 2, columnCount: 2 })
    ])
    expect(html).toContain('这张表是空的')
    expect(html).not.toContain('<table>')
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

  it('横向合并只出一格并带 colspan，被盖住的格不重复画', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('Sheet1', [['标题', '', ''], [1, 2, 3]], { merges: ['A1:C1'] })
    ])
    expect(html).toContain('colspan="3"')
    expect(html).toContain('>标题<')
    const dataRow = html.match(/<td class="row-header">1<\/td>(.*?)<\/tr>/)?.[1] ?? ''
    expect(dataRow.match(/<td/g)?.length).toBe(1)
    expect(dataRow).not.toContain('<td></td>')
  })

  it('纵向合并带 rowspan，后续行跳过被盖住的格', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('Sheet1', [['类', 'a'], ['', 'b'], ['', 'c']], { merges: ['A1:A3'] })
    ])
    expect(html).toContain('rowspan="3"')
    expect(html).toContain('>类<')
    const row2 = html.match(/<td class="row-header">2<\/td>(.*?)<\/tr>/)?.[1] ?? ''
    expect(row2.match(/<td/g)?.length).toBe(1)
    expect(row2).toContain('>b<')
  })

  it('矩形合并同时带 colspan 与 rowspan', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('Sheet1', [['块', '', 'x'], ['', '', 'y']], { merges: ['A1:B2'] })
    ])
    expect(html).toContain('colspan="2"')
    expect(html).toContain('rowspan="2"')
    expect(html).toContain('class="merged"')
    expect(html).toContain('>块<')
  })

  it('合并区能把预览列数撑开，避免标题只占一列', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('Sheet1', [['总表']], { columnCount: 1, merges: ['A1:D1'] })
    ])
    expect(html).toContain('<th>D</th>')
    expect(html).toContain('colspan="4"')
    expect(html).toContain('>总表<')
  })

  it('中等表整张画出，不再按 100 行 20 列截断', () => {
    const rows = Array.from({ length: 120 }, (_, i) =>
      Array.from({ length: 25 }, (_, j) => (i === 0 ? `c${j + 1}` : i * 25 + j))
    )
    const html = renderExcelWorkbookPreviewHtml([sheet('Sheet1', rows)])
    expect(html).toContain('<th>Y</th>')
    expect(html).toContain('<td class="row-header">120</td>')
    expect(html).not.toContain('显示 ')
  })

  it('列数大到会卡才截断并标明只预览了一部分', () => {
    const wide = [Array.from({ length: 151 }, (_, i) => i + 1)]
    const html = renderExcelWorkbookPreviewHtml([
      sheet('Sheet1', wide, { rowCount: 1, columnCount: 151 })
    ])
    expect(html).toContain('<th>ET</th>')
    expect(html).not.toContain('<th>EU</th>')
    expect(html).toContain('class="sheet-truncated"')
    expect(html).toContain('只预览了 150/151 列，后面没有画出来')
  })

  it('带 sheet 前缀的合并区也能解析', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('收入', [['合计']], { merges: ["'收入'!A1:B1"] })
    ])
    expect(html).toContain('colspan="2"')
  })
})

describe('renderExcelWorkbookPreviewHtml + ExcelJS', () => {
  it('从真实工作表读取合并区', async () => {
    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet1')
    ws.getCell('A1').value = '标题'
    ws.mergeCells('A1:C1')
    ws.getCell('A2').value = 1
    ws.getCell('B2').value = 2
    ws.getCell('C2').value = 3

    const html = renderExcelWorkbookPreviewHtml(wb.worksheets)
    expect(html).toContain('colspan="3"')
    expect(html).toContain('>标题<')
    const dataRow = html.match(/<td class="row-header">1<\/td>(.*?)<\/tr>/)?.[1] ?? ''
    expect(dataRow.match(/<td/g)?.length).toBe(1)
  })
})
