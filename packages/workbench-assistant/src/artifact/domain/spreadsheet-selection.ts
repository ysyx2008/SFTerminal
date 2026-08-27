/**
 * Excel 预览圈选：从带 data-r/data-c 的格子算出矩形范围和给助手的摘录。
 */

import { boxFromRect, type ContextMenuBox } from './context-menu-position'

export const SPREADSHEET_SELECTED_CLASS = 'sf-ss-selected'
export const SPREADSHEET_EXCERPT_CELL_CAP = 80

export interface SpreadsheetRect {
  top: number
  left: number
  bottom: number
  right: number
}

export interface SpreadsheetCellSpan {
  row: number
  col: number
  rowspan: number
  colspan: number
}

export function columnLetter(col: number): string {
  let n = col
  let result = ''
  while (n > 0) {
    n--
    result = String.fromCharCode(65 + (n % 26)) + result
    n = Math.floor(n / 26)
  }
  return result
}

export function cellAddress(row: number, col: number): string {
  return `${columnLetter(col)}${row}`
}

export function a1Range(rect: SpreadsheetRect): string {
  const start = cellAddress(rect.top, rect.left)
  const end = cellAddress(rect.bottom, rect.right)
  return start === end ? start : `${start}:${end}`
}

export function normalizeRect(a: SpreadsheetRect, b: SpreadsheetRect): SpreadsheetRect {
  return {
    top: Math.min(a.top, b.top),
    left: Math.min(a.left, b.left),
    bottom: Math.max(a.bottom, b.bottom),
    right: Math.max(a.right, b.right)
  }
}

export function spanToRect(span: SpreadsheetCellSpan): SpreadsheetRect {
  return {
    top: span.row,
    left: span.col,
    bottom: span.row + Math.max(1, span.rowspan) - 1,
    right: span.col + Math.max(1, span.colspan) - 1
  }
}

export function rectsIntersect(a: SpreadsheetRect, b: SpreadsheetRect): boolean {
  return a.top <= b.bottom && a.bottom >= b.top && a.left <= b.right && a.right >= b.left
}

export function shouldKeepSpreadsheetSelection(
  prev: { filePath: string | null; artifactId: string; sheet: string } | undefined,
  curr: { filePath: string | null; artifactId: string; sheet: string }
): boolean {
  return !!prev
    && prev.filePath === curr.filePath
    && prev.artifactId === curr.artifactId
    && prev.sheet === curr.sheet
}

/** 刷新后这块格子还在表上才保留高亮，避免行列没了还亮着空位 */
export function selectionRectStillOnSheet(
  rect: SpreadsheetRect,
  spans: readonly SpreadsheetCellSpan[]
): boolean {
  return spans.some(span => rectsIntersect(rect, spanToRect(span)))
}

/** 圈到合并格的一部分时，范围扩到整块合并区（跟 Excel 一样） */
export function expandRectToSpans(rect: SpreadsheetRect, spans: readonly SpreadsheetCellSpan[]): SpreadsheetRect {
  let next = rect
  for (let safety = 0; safety < 20; safety++) {
    let changed = false
    for (const span of spans) {
      const spanRect = spanToRect(span)
      if (rectsIntersect(next, spanRect)) {
        const grown = normalizeRect(next, spanRect)
        if (
          grown.top !== next.top ||
          grown.left !== next.left ||
          grown.bottom !== next.bottom ||
          grown.right !== next.right
        ) {
          next = grown
          changed = true
        }
      }
    }
    if (!changed) break
  }
  return next
}

export function formatSpreadsheetExcerpt(opts: {
  sheet: string
  rect: SpreadsheetRect
  cells: ReadonlyArray<{ address: string; value: string }>
}): string {
  const lines = [
    `Sheet: ${opts.sheet}`,
    `Range: ${a1Range(opts.rect)}`
  ]
  const shown = opts.cells.slice(0, SPREADSHEET_EXCERPT_CELL_CAP)
  for (const cell of shown) {
    lines.push(`${cell.address}: ${cell.value}`)
  }
  const extra = opts.cells.length - shown.length
  if (extra > 0) lines.push(`… (${extra} more cells)`)
  return lines.join('\n')
}

function parsePositiveInt(value: string | null | undefined): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : null
}

export function cellSpanFromElement(el: Element): SpreadsheetCellSpan | null {
  const row = parsePositiveInt(el.getAttribute('data-r'))
  const col = parsePositiveInt(el.getAttribute('data-c'))
  if (row == null || col == null) return null
  return {
    row,
    col,
    rowspan: el instanceof HTMLTableCellElement ? Math.max(1, el.rowSpan || 1) : 1,
    colspan: el instanceof HTMLTableCellElement ? Math.max(1, el.colSpan || 1) : 1
  }
}

export function visibleSheetPane(root: ParentNode | null): HTMLElement | null {
  if (!root || !('querySelector' in root)) return null
  return root.querySelector<HTMLElement>('.sheet-pane:not([hidden])')
}

export function cellFromTarget(target: EventTarget | null, root: ParentNode | null): SpreadsheetCellSpan | null {
  if (!(target instanceof Element) || !root || !('contains' in root)) return null
  const td = target.closest('td[data-r][data-c]')
  if (!td || !root.contains(td)) return null
  return cellSpanFromElement(td)
}

/** pointer capture 会把 target 改成捕获节点，按坐标回找真实格子 */
export function cellFromPoint(x: number, y: number, root: ParentNode | null): SpreadsheetCellSpan | null {
  return cellFromTarget(document.elementFromPoint(x, y), root)
}

export interface SpreadsheetCellEl {
  el: Element
  span: SpreadsheetCellSpan
}

export function listCellElements(pane: ParentNode | null): SpreadsheetCellEl[] {
  if (!pane || !('querySelectorAll' in pane)) return []
  const out: SpreadsheetCellEl[] = []
  for (const el of pane.querySelectorAll('td[data-r][data-c]')) {
    const span = cellSpanFromElement(el)
    if (span) out.push({ el, span })
  }
  return out
}

export function listCellSpans(pane: ParentNode | null): SpreadsheetCellSpan[] {
  return listCellElements(pane).map(cell => cell.span)
}

export function applySpreadsheetSelectionToCells(
  cells: readonly SpreadsheetCellEl[],
  rect: SpreadsheetRect | null
): void {
  for (const { el, span } of cells) {
    el.classList.toggle(SPREADSHEET_SELECTED_CLASS, !!(rect && rectsIntersect(rect, spanToRect(span))))
  }
}

export function applySpreadsheetSelection(pane: ParentNode | null, rect: SpreadsheetRect | null): void {
  applySpreadsheetSelectionToCells(listCellElements(pane), rect)
}

export function clearSpreadsheetSelection(root: ParentNode | null): void {
  if (!root || !('querySelectorAll' in root)) return
  for (const el of root.querySelectorAll(`.${SPREADSHEET_SELECTED_CLASS}`)) {
    el.classList.remove(SPREADSHEET_SELECTED_CLASS)
  }
}

export function readSelectedCells(
  pane: ParentNode | null,
  rect: SpreadsheetRect
): Array<{ address: string; value: string }> {
  if (!pane || !('querySelectorAll' in pane)) return []
  const cells: Array<{ address: string; value: string; row: number; col: number }> = []
  for (const el of pane.querySelectorAll('td[data-r][data-c]')) {
    const span = cellSpanFromElement(el)
    if (!span || !rectsIntersect(rect, spanToRect(span))) continue
    cells.push({
      address: cellAddress(span.row, span.col),
      value: (el.textContent ?? '').replace(/\u00a0/g, ' ').trim(),
      row: span.row,
      col: span.col
    })
  }
  cells.sort((a, b) => a.row - b.row || a.col - b.col)
  return cells.map(({ address, value }) => ({ address, value }))
}

export function spreadsheetSelectionBox(pane: Element | null): ContextMenuBox | null {
  if (!pane) return null
  const selected = [...pane.querySelectorAll(`.${SPREADSHEET_SELECTED_CLASS}`)]
  if (selected.length === 0) return null
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const el of selected) {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 && r.height <= 0) continue
    left = Math.min(left, r.left)
    top = Math.min(top, r.top)
    right = Math.max(right, r.right)
    bottom = Math.max(bottom, r.bottom)
  }
  if (!Number.isFinite(left) || right <= left || bottom <= top) return null
  return boxFromRect(new DOMRect(left, top, right - left, bottom - top))
}
