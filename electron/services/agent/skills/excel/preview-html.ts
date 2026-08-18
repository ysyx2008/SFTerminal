/**
 * Excel 工作簿 → 产出物面板预览 HTML（只读，含全部 sheet 供切表）
 */
import { formatCellValue } from './cell-value'

export interface PreviewHighlights {
  modified?: Set<string>
  deleting?: Set<string>
  /** 删除行后上移的单元格 */
  shifted?: Set<string>
  /** 删除列后左移的单元格 */
  shiftedCol?: Set<string>
}

interface PreviewCell {
  value: unknown
}

interface PreviewRow {
  eachCell: (
    options: { includeEmpty: boolean },
    cb: (cell: PreviewCell, colNum: number) => void
  ) => void
}

export interface PreviewWorksheet {
  name: string
  rowCount: number
  columnCount: number
  eachRow: (
    options: { includeEmpty: boolean },
    cb: (row: PreviewRow, rowNum: number) => void
  ) => void
}

const PREVIEW_MAX_ROWS = 100
const PREVIEW_MAX_COLS = 20

export function escapePreviewHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function numberToColumnLetter(num: number): string {
  let result = ''
  let n = num
  while (n > 0) {
    n--
    result = String.fromCharCode(65 + (n % 26)) + result
    n = Math.floor(n / 26)
  }
  return result
}

function isNumericCellValue(value: unknown): boolean {
  if (typeof value === 'number') return true
  if (typeof value === 'object' && value !== null && 'result' in value) {
    return typeof (value as { result: unknown }).result === 'number'
  }
  return false
}

function renderSheetTable(
  sheet: PreviewWorksheet,
  highlights?: PreviewHighlights
): string {
  if (sheet.rowCount === 0) {
    return '<p><em>(空工作表)</em></p>'
  }

  const maxRows = Math.min(sheet.rowCount, PREVIEW_MAX_ROWS)
  const maxCols = Math.min(sheet.columnCount, PREVIEW_MAX_COLS)

  // 只读遍历已有数据，避免 getRow/getCell 创建空对象污染 workbook
  const dataRows: Map<number, Map<number, { val: string; isNum: boolean }>> = new Map()
  let actualMaxCol = 0

  sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum > maxRows) return
    const cellMap = new Map<number, { val: string; isNum: boolean }>()
    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      if (colNum > maxCols) return
      cellMap.set(colNum, {
        val: formatCellValue(cell.value),
        isNum: isNumericCellValue(cell.value)
      })
      if (colNum > actualMaxCol) actualMaxCol = colNum
    })
    dataRows.set(rowNum, cellMap)
  })

  const colCount = Math.min(actualMaxCol, maxCols) || 1
  const htmlRows: string[] = []

  const colHeaders = ['<th class="corner"></th>']
  for (let c = 1; c <= colCount; c++) {
    colHeaders.push(`<th>${numberToColumnLetter(c)}</th>`)
  }
  htmlRows.push(`<tr>${colHeaders.join('')}</tr>`)

  for (let r = 1; r <= maxRows; r++) {
    const cellMap = dataRows.get(r)
    const cells = [`<td class="row-header">${r}</td>`]
    for (let c = 1; c <= colCount; c++) {
      const data = cellMap?.get(c)
      const key = `${r},${c}`
      const classes: string[] = []
      if (data?.isNum) classes.push('num')
      if (highlights?.deleting?.has(key)) classes.push('deleting')
      else if (highlights?.shifted?.has(key)) classes.push('shifted')
      else if (highlights?.shiftedCol?.has(key)) classes.push('shifted-col')
      else if (highlights?.modified?.has(key)) classes.push('modified')
      const classAttr = classes.length > 0 ? ` class="${classes.join(' ')}"` : ''
      cells.push(data
        ? `<td${classAttr}>${escapePreviewHtml(data.val)}</td>`
        : `<td${classAttr}></td>`)
    }
    htmlRows.push(`<tr>${cells.join('')}</tr>`)
  }

  const parts = [`<table>${htmlRows.join('')}</table>`]
  if (sheet.rowCount > maxRows || sheet.columnCount > maxCols) {
    parts.push(
      `<p style="color: #888; font-size: 11px; margin-top: 4px;">显示 ${maxRows}/${sheet.rowCount} 行, ${maxCols}/${sheet.columnCount} 列</p>`
    )
  }
  return parts.join('\n')
}

/**
 * 生成含全部工作表的只读预览 HTML。
 * 多表时底部带可点标签；默认展示 activeSheet（缺省为第一张）。
 */
export function renderExcelWorkbookPreviewHtml(
  worksheets: readonly PreviewWorksheet[],
  options?: { activeSheet?: string; highlights?: PreviewHighlights }
): string {
  if (worksheets.length === 0) return '<p><em>(空工作簿)</em></p>'

  const activeName = options?.activeSheet && worksheets.some(ws => ws.name === options.activeSheet)
    ? options.activeSheet
    : worksheets[0].name

  const parts: string[] = []
  for (const ws of worksheets) {
    const isActive = ws.name === activeName
    const hiddenAttr = isActive ? '' : ' hidden'
    const sheetHighlights = isActive ? options?.highlights : undefined
    parts.push(
      `<div class="sheet-pane" data-sheet="${escapePreviewHtml(ws.name)}"${hiddenAttr}>`
    )
    parts.push(renderSheetTable(ws, sheetHighlights))
    parts.push('</div>')
  }

  if (worksheets.length > 1) {
    const tabs = worksheets.map(ws => {
      const isActive = ws.name === activeName
      return `<span class="sheet-tab${isActive ? ' active' : ''}" data-sheet="${escapePreviewHtml(ws.name)}">${escapePreviewHtml(ws.name)}</span>`
    }).join('')
    parts.push(`<div class="sheet-tabs">${tabs}</div>`)
  }

  return parts.join('\n')
}
