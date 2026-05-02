/**
 * Excel 模板填充
 *
 * 把 .xlsx 模板里的 {{占位符}} 用 JSON 数据填充，输出新文件。
 *
 * 支持的循环形态：
 *  - **单行循环**：在某一行的某个单元格写 `{{#each items}}`，同一行内任一单元格写 `{{/each}}`，
 *    该行作为"模板行"，按数据数组复制成多行；公式中的相对行引用自动按行偏移。
 *
 * 不支持（v1）：
 *  - 多行模板循环（each 与 /each 不在同一行）
 *  - 模板行内有合并单元格
 *  - 嵌套循环
 *  - 跨 sheet 引用调整
 *  - 图表数据源调整
 */

import type * as ExcelJS from 'exceljs'
import {
  findPlaceholders,
  resolveValue,
  makeLoopContext,
  stringifyValue,
  type MissingStrategy
} from '../../../../utils/template-engine'

export interface MergeOptions {
  onMissing?: MissingStrategy
  /** 限定只处理某个 sheet（可选；不指定则处理所有 sheet） */
  sheet?: string
}

export interface LoopExpansion {
  kind: 'row'
  field: string
  count: number
  sheet: string
}

export interface MergeResult {
  replaced: string[]
  missing: string[]
  loopExpansions: LoopExpansion[]
}

/**
 * 对 .xlsx 模板执行 merge，写入到目标路径。
 */
export async function mergeXlsxFile(
  templatePath: string,
  outputPath: string,
  data: Record<string, unknown>,
  options: MergeOptions = {}
): Promise<MergeResult> {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(templatePath)

  const replacedSet = new Set<string>()
  const missingSet = new Set<string>()
  const loopExpansions: LoopExpansion[] = []
  const onMissing = options.onMissing ?? 'error'

  workbook.eachSheet((worksheet) => {
    if (options.sheet && worksheet.name !== options.sheet) return
    mergeWorksheet(worksheet, data, {
      onMissing,
      replacedSet,
      missingSet,
      loopExpansions
    })
  })

  workbook.calcProperties = { fullCalcOnLoad: true }
  await workbook.xlsx.writeFile(outputPath)

  return {
    replaced: Array.from(replacedSet),
    missing: Array.from(missingSet),
    loopExpansions
  }
}

interface MergeContext {
  onMissing: MissingStrategy
  replacedSet: Set<string>
  missingSet: Set<string>
  loopExpansions: LoopExpansion[]
}

function mergeWorksheet(
  ws: ExcelJS.Worksheet,
  data: Record<string, unknown>,
  ctx: MergeContext
): void {
  // 1. 行级循环展开（自上而下处理，每展开一次行号会变，需要重扫）
  for (let safety = 0; safety < 50; safety++) {
    const loop = findRowLoop(ws)
    if (!loop) break

    const r = resolveValue(data, loop.field)
    if (!r.found || !Array.isArray(r.value)) {
      ctx.missingSet.add(loop.field)
      // 清除 each marker 的占位符文本，避免下一轮重复扫
      clearEachMarkersInRow(ws, loop.row)
      if (ctx.onMissing !== 'keep') {
        // 不是数组：删除整个模板行
        ws.spliceRows(loop.row, 1)
      }
      continue
    }

    const arr = r.value as unknown[]
    expandRowLoop(ws, loop.row, loop.field, arr, data, ctx)
    ctx.loopExpansions.push({
      kind: 'row',
      field: loop.field,
      count: arr.length,
      sheet: ws.name
    })
  }

  // 2. 简单占位符替换：扫所有单元格
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      replaceCellPlaceholders(cell, data, ctx)
    })
  })
}

// ============ 行级循环检测 ============

interface RowLoop {
  row: number
  field: string
}

/**
 * 找第一个行级循环。
 *
 * 条件：某行内某个单元格的文本包含 `{{#each xxx}}`，且同一行内某个单元格包含 `{{/each}}`。
 */
function findRowLoop(ws: ExcelJS.Worksheet): RowLoop | null {
  let found: RowLoop | null = null
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (found) return
    let eachField: string | null = null
    let hasEnd = false
    row.eachCell({ includeEmpty: false }, (cell) => {
      const text = getCellText(cell)
      if (!text) return
      const placeholders = findPlaceholders(text)
      for (const p of placeholders) {
        if (p.kind === 'each-start' && eachField === null) eachField = p.expr
        if (p.kind === 'each-end') hasEnd = true
      }
    })
    if (eachField && hasEnd) found = { row: rowNum, field: eachField }
  })
  return found
}

/**
 * 取单元格中的文本表示（仅当 value 是字符串或对象 {text} 时才返回）。
 *
 * 公式单元格的"占位符"在 formula 字段处理。
 */
function getCellText(cell: ExcelJS.Cell): string | null {
  const v = cell.value
  if (v == null) return null
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    const obj = v as unknown as Record<string, unknown>
    if ('richText' in obj && Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>).map(r => r.text ?? '').join('')
    }
    if ('text' in obj) return String(obj.text)
  }
  return null
}

/**
 * 设置单元格文本（保留富文本结构时尽量保留首段格式）。
 */
function setCellText(cell: ExcelJS.Cell, newText: string): void {
  const v = cell.value
  if (v && typeof v === 'object' && 'richText' in (v as unknown as Record<string, unknown>)) {
    // 富文本：把首段的格式继承给新文本
    const rt = (v as { richText?: Array<{ text?: string; font?: unknown }> }).richText
    if (rt && rt.length > 0 && rt[0].font) {
      cell.value = { richText: [{ text: newText, font: rt[0].font }] } as ExcelJS.CellValue
      return
    }
  }
  cell.value = newText
}

// ============ 行级循环展开 ============

/**
 * 把模板行展开为 N 行。
 *
 * 算法：
 *  1. 收集模板行的所有 cell（value/style/formula/数据校验等）
 *  2. 在模板行后插入 N-1 行空行
 *  3. 把模板行复制到第 0 个副本（保留原位置），其余副本在新插入的行
 *  4. 对每个副本，应用循环 context 替换占位符；公式按行偏移
 *  5. 清除所有 each-marker 占位符
 */
function expandRowLoop(
  ws: ExcelJS.Worksheet,
  templateRow: number,
  field: string,
  arr: unknown[],
  parentData: Record<string, unknown>,
  ctx: MergeContext
): void {
  const colCount = ws.columnCount
  // 收集模板单元格的"原始信息"
  interface CellSnapshot {
    col: number
    value: ExcelJS.CellValue
    style: Partial<ExcelJS.Style>
    isFormula: boolean
    formula?: string
  }
  const template: CellSnapshot[] = []
  const tplRow = ws.getRow(templateRow)
  for (let c = 1; c <= colCount; c++) {
    const cell = tplRow.getCell(c)
    if (cell.value == null && !hasMeaningfulStyle(cell)) continue
    const isFormula = isFormulaCell(cell)
    template.push({
      col: c,
      value: cell.value,
      style: cloneStyle(cell.style),
      isFormula,
      formula: isFormula ? extractFormulaString(cell) : undefined
    })
  }

  if (arr.length === 0) {
    // 空数组：直接删除模板行
    ws.spliceRows(templateRow, 1)
    return
  }

  // 在模板行后插入 (arr.length - 1) 行空行
  // 注意：避免 spread 大数组（spliceRows(start, 0, ...largeArr) 会栈溢出）
  // 改用循环逐行插入，每次插入位置始终是 templateRow + 1（原模板行后）
  for (let i = 1; i < arr.length; i++) {
    ws.spliceRows(templateRow + 1, 0, [])
  }

  for (let idx = 0; idx < arr.length; idx++) {
    const targetRowNum = templateRow + idx
    const targetRow = ws.getRow(targetRowNum)
    const itemCtx = makeLoopContext(arr[idx], idx, parentData)
    const rowOffset = idx

    for (const snap of template) {
      const targetCell = targetRow.getCell(snap.col)
      targetCell.style = cloneStyle(snap.style)
      writeSnapshotToCell(targetCell, snap, itemCtx, rowOffset, ctx)
    }
    targetRow.commit?.()
  }
}

/**
 * 把模板单元格快照按当前循环 context 写入目标单元格。
 *
 * 三种情况：
 *  - 公式：按行偏移并替换占位符
 *  - 字符串/富文本：替换占位符（保留首段富文本格式）
 *  - 其他（数字、日期、布尔）：原样拷贝
 */
function writeSnapshotToCell(
  cell: ExcelJS.Cell,
  snap: { value: ExcelJS.CellValue; isFormula: boolean; formula?: string },
  itemCtx: Record<string, unknown>,
  rowOffset: number,
  ctx: MergeContext
): void {
  if (snap.isFormula && snap.formula) {
    const shifted = shiftFormulaRows(snap.formula, rowOffset)
    const filledFormula = fillStringWithEachMarkers(shifted, itemCtx, ctx)
    cell.value = { formula: filledFormula } as ExcelJS.CellValue
    return
  }

  const v = snap.value
  if (typeof v === 'string') {
    cell.value = renderCellString(v, itemCtx, ctx)
    return
  }
  if (v && typeof v === 'object' && 'richText' in (v as unknown as Record<string, unknown>)) {
    const rt = (v as { richText?: Array<{ text?: string; font?: unknown }> }).richText
    const joined = (rt ?? []).map(r => r.text ?? '').join('')
    const rendered = renderCellString(joined, itemCtx, ctx)
    if (typeof rendered === 'string' && rt && rt.length > 0 && rt[0].font) {
      cell.value = { richText: [{ text: rendered, font: rt[0].font }] } as ExcelJS.CellValue
    } else {
      cell.value = rendered
    }
    return
  }
  cell.value = v
}

/**
 * 渲染单元格字符串：清除 each marker，再决定是保留原始类型还是字符串拼接。
 *
 * 关键规则：当清除 each marker 后剩下的内容（trim 后）正好是单个 `{{xxx}}` 占位符时，
 * 直接返回 resolveValue 的原始值（数字/布尔/日期保持类型，不被字符串化）。
 */
function renderCellString(
  text: string,
  data: Record<string, unknown>,
  ctx: MergeContext
): ExcelJS.CellValue {
  // 1. 清除 each-start / each-end 标记
  const phsAll = findPlaceholders(text)
  let cleaned = text
  for (let i = phsAll.length - 1; i >= 0; i--) {
    const p = phsAll[i]
    if (p.kind === 'each-start' || p.kind === 'each-end') {
      cleaned = cleaned.slice(0, p.start) + cleaned.slice(p.end)
    }
  }

  // 2. 检查是否是"整段单个 value 占位符"（前后只有空白）
  // 此时只有基本类型（string/number/boolean/Date）保留原始类型，对象/数组走字符串化
  // 否则 ExcelJS 不支持，会写出 [object Object] 或抛运行时错误
  const cleanedPhs = findPlaceholders(cleaned)
  if (cleanedPhs.length === 1 && cleanedPhs[0].kind === 'value') {
    const p = cleanedPhs[0]
    const before = cleaned.slice(0, p.start)
    const after = cleaned.slice(p.end)
    if (before.trim() === '' && after.trim() === '') {
      const r = resolveValue(data, p.expr)
      if (r.found) {
        ctx.replacedSet.add(p.expr)
        if (isExcelPrimitive(r.value)) {
          return r.value as ExcelJS.CellValue
        }
        return stringifyValue(r.value)
      }
      ctx.missingSet.add(p.expr)
      if (ctx.onMissing === 'empty') return null as unknown as ExcelJS.CellValue
      if (ctx.onMissing === 'keep') return text as ExcelJS.CellValue
      return '' as ExcelJS.CellValue
    }
  }

  // 3. 字符串拼接路径
  return fillStringWithEachMarkers(cleaned, data, ctx)
}

/**
 * 在字符串里替换 {{xxx}} 占位符并清除 each marker。
 *
 * 用于单元格文本和公式字符串。
 */
function fillStringWithEachMarkers(
  text: string,
  data: Record<string, unknown>,
  ctx: MergeContext
): string {
  const placeholders = findPlaceholders(text)
  if (placeholders.length === 0) return text

  let result = text
  for (let i = placeholders.length - 1; i >= 0; i--) {
    const p = placeholders[i]
    if (p.kind === 'each-start' || p.kind === 'each-end') {
      result = result.slice(0, p.start) + result.slice(p.end)
      continue
    }
    const r = resolveValue(data, p.expr)
    if (r.found) {
      ctx.replacedSet.add(p.expr)
      result = result.slice(0, p.start) + stringifyValue(r.value) + result.slice(p.end)
    } else {
      ctx.missingSet.add(p.expr)
      if (ctx.onMissing === 'empty') {
        result = result.slice(0, p.start) + result.slice(p.end)
      }
    }
  }
  return result
}

/**
 * 替换单元格内的简单占位符（不处理 each marker，假定 each 已展开）。
 *
 * 当单元格文本是单个 `{{xxx}}` 时，保留 resolveValue 的原始类型（不强制字符串化）。
 */
function replaceCellPlaceholders(
  cell: ExcelJS.Cell,
  data: Record<string, unknown>,
  ctx: MergeContext
): void {
  // 普通文本单元格
  const text = getCellText(cell)
  if (text != null && findPlaceholders(text).some(p => p.kind === 'value')) {
    const rendered = renderCellString(text, data, ctx)
    // 如果是字符串则走 setCellText 保留富文本格式，其他类型直接赋值
    if (typeof rendered === 'string') {
      setCellText(cell, rendered)
    } else {
      cell.value = rendered
    }
    return
  }

  // 公式单元格
  if (isFormulaCell(cell)) {
    const formula = extractFormulaString(cell)
    if (formula && findPlaceholders(formula).some(p => p.kind === 'value')) {
      const newFormula = fillStringWithEachMarkers(formula, data, ctx)
      cell.value = { formula: newFormula } as ExcelJS.CellValue
    }
  }
}

// ============ 公式工具 ============

/**
 * 判断是否为公式单元格。
 *
 * 兼容 ExcelJS 的两种公式形态：
 * - 普通公式：`{ formula: 'A1+B1', result?: ... }`（CellFormulaValue）
 * - 共享公式：`{ sharedFormula: 'A1+B1', result?: ... }`（CellSharedFormulaValue）
 *   出现于 Excel 中多行相同公式被自动合并的场景，
 *   也常出现于从外部 .xlsx 文件导入的模板里。
 */
export function isFormulaCell(cell: ExcelJS.Cell): boolean {
  const v = cell.value
  if (v && typeof v === 'object') {
    const obj = v as unknown as Record<string, unknown>
    if ('formula' in obj || 'sharedFormula' in obj) return true
  }
  if (cell.formula) return true
  return false
}

/**
 * 提取公式字符串，优先 formula，其次 sharedFormula，最后回退到 cell.formula getter。
 */
export function extractFormulaString(cell: ExcelJS.Cell): string {
  const v = cell.value
  if (v && typeof v === 'object') {
    const obj = v as unknown as Record<string, unknown>
    if ('formula' in obj && obj.formula != null) {
      return String(obj.formula)
    }
    if ('sharedFormula' in obj && obj.sharedFormula != null) {
      return String(obj.sharedFormula)
    }
  }
  return cell.formula ?? ''
}

/**
 * 把公式中的相对行引用按 offset 偏移。
 *
 * 规则：
 *  - `A1` → `A(1+offset)`（行未加 $）
 *  - `$A1` → `$A(1+offset)`（行未加 $）
 *  - `A$1` → `A$1`（行加了 $，不偏移）
 *  - `$A$1` → `$A$1`（绝对引用，不偏移）
 *  - 范围引用 `A1:B10` → 两端各自处理
 *
 * 已知边界：
 *  - 不处理函数名/标识符的边界（如 `LOG10(x)` 中的 `LOG10` 不是 cell 引用，但目前用 lookbehind 排除字母后跟数字的情况）
 */
/** Excel 行号上限（xlsx 2007+） */
const EXCEL_MAX_ROWS = 1048576

/** 判断值是否能直接作为 Excel cell.value 使用（保留原始类型） */
function isExcelPrimitive(v: unknown): boolean {
  if (v == null) return true
  const t = typeof v
  if (t === 'string' || t === 'number' || t === 'boolean') return true
  if (v instanceof Date) return true
  return false
}

export function shiftFormulaRows(formula: string, offset: number): string {
  if (offset === 0) return formula
  // 匹配 (前置非字母数字下划线$) ($?) ([A-Z]+) ($?) (数字) (后置非数字且非"(")
  // - 前置 lookbehind: 避免匹配 ABC123 中的 BC123
  // - 后置 lookahead `(?![\d(])`: 既排除多位数字延续（A1 不吃 A12），也排除函数调用（LOG10(...)）
  return formula.replace(
    /(?<![A-Za-z0-9_$])(\$?)([A-Z]+)(\$?)(\d+)(?![\d(])/g,
    (m, c1, col, c2, row) => {
      if (c2 === '$') return m
      const newRow = parseInt(row, 10) + offset
      // 越界保护：超出 Excel 行号上下限时保留原引用，避免生成无效引用
      if (newRow < 1 || newRow > EXCEL_MAX_ROWS) return m
      return `${c1}${col}${c2}${newRow}`
    }
  )
}

// ============ 样式拷贝 ============

function hasMeaningfulStyle(cell: ExcelJS.Cell): boolean {
  const s = cell.style
  if (!s) return false
  return Boolean(s.font || s.fill || s.border || s.alignment || s.numFmt)
}

function cloneStyle(style: Partial<ExcelJS.Style> | undefined): Partial<ExcelJS.Style> {
  if (!style) return {}
  // 深拷贝避免共享引用导致后续修改互相影响
  return JSON.parse(JSON.stringify(style)) as Partial<ExcelJS.Style>
}

// ============ 清除 each marker ============

function clearEachMarkersInRow(ws: ExcelJS.Worksheet, rowNum: number): void {
  const row = ws.getRow(rowNum)
  row.eachCell({ includeEmpty: false }, (cell) => {
    const text = getCellText(cell)
    if (!text) return
    const placeholders = findPlaceholders(text)
    if (!placeholders.some(p => p.kind !== 'value')) return
    let newText = text
    for (let i = placeholders.length - 1; i >= 0; i--) {
      const p = placeholders[i]
      if (p.kind === 'value') continue
      newText = newText.slice(0, p.start) + newText.slice(p.end)
    }
    setCellText(cell, newText)
  })
}
