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

export interface PreviewMerge {
  top: number
  left: number
  bottom: number
  right: number
}

export interface PreviewWorksheet {
  name: string
  rowCount: number
  columnCount: number
  /** 合并区（1-based）。缺省时从 ExcelJS 工作表上的合并记录读取。 */
  merges?: readonly PreviewMerge[] | readonly string[]
  eachRow: (
    options: { includeEmpty: boolean },
    cb: (row: PreviewRow, rowNum: number) => void
  ) => void
}

/** 普通表整张画；超过这些上限才截，避免 DOM 卡死。 */
const PREVIEW_MAX_CELLS = 80_000
const PREVIEW_MAX_ROWS = 5_000
const PREVIEW_MAX_COLS = 150

/** 预览画多少行/列：先按表的实际大小，再套卡顿上限。 */
export function previewTableExtent(rowCount: number, colCount: number): { rows: number; cols: number } {
  const rows = Math.min(Math.max(0, rowCount), PREVIEW_MAX_ROWS)
  const cols = Math.min(Math.max(0, colCount), PREVIEW_MAX_COLS)
  if (rows === 0 || cols === 0) return { rows, cols }
  if (rows * cols <= PREVIEW_MAX_CELLS) return { rows, cols }
  return { rows: Math.min(rows, Math.max(1, Math.floor(PREVIEW_MAX_CELLS / cols))), cols }
}

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

function letterToColumnNumber(letter: string): number {
  let n = 0
  for (let i = 0; i < letter.length; i++) {
    const code = letter.charCodeAt(i)
    const digit = code >= 97 ? code - 96 : code - 64
    if (digit < 1 || digit > 26) return 0
    n = n * 26 + digit
  }
  return n
}

function isMergeRect(value: unknown): value is PreviewMerge {
  if (!value || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  return (
    typeof o.top === 'number' &&
    typeof o.left === 'number' &&
    typeof o.bottom === 'number' &&
    typeof o.right === 'number'
  )
}

function parseA1MergeRange(range: string): PreviewMerge | null {
  const bang = range.lastIndexOf('!')
  const bare = bang >= 0 ? range.slice(bang + 1) : range
  const m = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(bare)
  if (!m) return null
  const left = letterToColumnNumber(m[1])
  const right = letterToColumnNumber(m[3])
  const top = Number(m[2])
  const bottom = Number(m[4])
  if (!left || !right || !top || !bottom) return null
  return {
    top: Math.min(top, bottom),
    left: Math.min(left, right),
    bottom: Math.max(top, bottom),
    right: Math.max(left, right)
  }
}

function addMerge(out: PreviewMerge[], seen: Set<string>, rect: PreviewMerge): void {
  const key = `${rect.top},${rect.left},${rect.bottom},${rect.right}`
  if (seen.has(key)) return
  seen.add(key)
  out.push(rect)
}

/**
 * 合并区来源：测试桩的 merges，或 ExcelJS 工作表上的 _merges（避免走 model getter 扫全表）。
 * _merges 的 Range 坐标是 1-based；ExcelJS 大版本升级时需核对。
 */
function collectMerges(sheet: PreviewWorksheet): PreviewMerge[] {
  const out: PreviewMerge[] = []
  const seen = new Set<string>()

  if (sheet.merges) {
    for (const item of sheet.merges) {
      if (typeof item === 'string') {
        const rect = parseA1MergeRange(item)
        if (rect) addMerge(out, seen, rect)
      } else if (isMergeRect(item)) {
        addMerge(out, seen, item)
      }
    }
  }

  const excelMerges = (sheet as { _merges?: Record<string, unknown> })._merges
  if (excelMerges && typeof excelMerges === 'object') {
    for (const item of Object.values(excelMerges)) {
      if (isMergeRect(item)) addMerge(out, seen, item)
    }
  }

  return out
}

function findMergeAt(merges: PreviewMerge[], row: number, col: number): PreviewMerge | undefined {
  return merges.find(m => row >= m.top && row <= m.bottom && col >= m.left && col <= m.right)
}

function highlightClass(key: string, highlights?: PreviewHighlights): string | undefined {
  if (!highlights) return undefined
  if (highlights.deleting?.has(key)) return 'deleting'
  if (highlights.shifted?.has(key)) return 'shifted'
  if (highlights.shiftedCol?.has(key)) return 'shifted-col'
  if (highlights.modified?.has(key)) return 'modified'
  return undefined
}

function renderEmptySheet(): string {
  return '<div class="sheet-empty">这张表是空的</div>'
}

function sheetHasVisibleContent(
  dataRows: Map<number, Map<number, { val: string; isNum: boolean }>>,
  merges: PreviewMerge[]
): boolean {
  if (merges.length > 0) return true
  for (const row of dataRows.values()) {
    for (const cell of row.values()) {
      if (cell.val !== '') return true
    }
  }
  return false
}

function renderSheetTable(
  sheet: PreviewWorksheet,
  highlights?: PreviewHighlights
): string {
  const merges = collectMerges(sheet)
  const mergeMaxRow = merges.reduce((acc, m) => Math.max(acc, m.bottom), 0)
  const mergeMaxCol = merges.reduce((acc, m) => Math.max(acc, m.right), 0)

  if (sheet.rowCount === 0 && mergeMaxRow === 0) {
    return renderEmptySheet()
  }

  const extent = previewTableExtent(
    Math.max(sheet.rowCount, mergeMaxRow),
    Math.max(sheet.columnCount, mergeMaxCol)
  )
  const maxRows = extent.rows
  const maxCols = extent.cols

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

  for (const merge of merges) {
    if (merge.top <= maxRows && merge.left <= maxCols) {
      actualMaxCol = Math.max(actualMaxCol, Math.min(merge.right, maxCols))
    }
  }

  if (!sheetHasVisibleContent(dataRows, merges)) {
    return renderEmptySheet()
  }

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
      const merge = findMergeAt(merges, r, c)
      if (merge && (r !== merge.top || c !== merge.left)) continue

      const data = cellMap?.get(c)
      const key = `${r},${c}`
      const classes: string[] = []
      if (data?.isNum) classes.push('num')
      const hl = highlightClass(key, highlights)
      if (hl) classes.push(hl)

      const colspan = merge ? Math.max(1, Math.min(merge.right, colCount) - merge.left + 1) : 1
      const rowspan = merge ? Math.max(1, Math.min(merge.bottom, maxRows) - merge.top + 1) : 1
      if (colspan > 1 || rowspan > 1) classes.push('merged')

      const classAttr = classes.length > 0 ? ` class="${classes.join(' ')}"` : ''
      const spanAttr = `${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}`
      cells.push(`<td${classAttr}${spanAttr}>${data ? escapePreviewHtml(data.val) : ''}</td>`)
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
  if (worksheets.length === 0) return '<div class="sheet-empty">这份工作簿是空的</div>'

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
