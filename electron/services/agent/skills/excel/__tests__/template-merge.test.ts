/**
 * Excel 模板填充：集成测试（构造真实 .xlsx 模板，再 merge）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { mergeXlsxFile, shiftFormulaRows } from '../template-merge'

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-excel-merge-test-'))
})

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function buildTemplate(
  filename: string,
  build: (ws: import('exceljs').Worksheet, wb: import('exceljs').Workbook) => void
): Promise<string> {
  const ExcelJS = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  build(ws, wb)
  const fp = path.join(tmpDir, filename)
  await wb.xlsx.writeFile(fp)
  return fp
}

async function readSheet(filePath: string, sheetName = 'Sheet1'): Promise<unknown[][]> {
  const ExcelJS = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const ws = wb.getWorksheet(sheetName)
  if (!ws) return []
  const rows: unknown[][] = []
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: unknown[] = []
    row.eachCell({ includeEmpty: false }, (cell) => {
      cells.push(cell.value)
    })
    rows.push(cells)
  })
  return rows
}

// ============ shiftFormulaRows 单元测试 ============

describe('shiftFormulaRows', () => {
  it('shifts simple cell reference', () => {
    expect(shiftFormulaRows('A1+B1', 2)).toBe('A3+B3')
  })

  it('preserves locked rows ($)', () => {
    expect(shiftFormulaRows('A$1+B1', 2)).toBe('A$1+B3')
  })

  it('preserves absolute references', () => {
    expect(shiftFormulaRows('$A$1+B1', 2)).toBe('$A$1+B3')
  })

  it('shifts column letters with multiple letters', () => {
    expect(shiftFormulaRows('AA1+AB2', 1)).toBe('AA2+AB3')
  })

  it('shifts both ends of range', () => {
    expect(shiftFormulaRows('SUM(A1:A10)', 5)).toBe('SUM(A6:A15)')
  })

  it('does not touch function names like LOG10', () => {
    expect(shiftFormulaRows('LOG10(B2)', 1)).toBe('LOG10(B3)')
  })

  it('returns same when offset is 0', () => {
    expect(shiftFormulaRows('A1+B1', 0)).toBe('A1+B1')
  })

  it('does not shift when result would exceed Excel max rows', () => {
    // 1048576 是 xlsx 行数上限，1048575 + 2 = 1048577 越界，应保留原引用
    expect(shiftFormulaRows('A1048575', 2)).toBe('A1048575')
  })

  it('does not shift function names with multiple letters', () => {
    expect(shiftFormulaRows('SUM(A1)+ABS(B1)', 1)).toBe('SUM(A2)+ABS(B2)')
  })

  it('handles multiple cell refs in one formula', () => {
    expect(shiftFormulaRows('A1+B1*C1-D1', 3)).toBe('A4+B4*C4-D4')
  })
})

// ============ 简单单元格替换 ============

describe('mergeXlsxFile: simple placeholders', () => {
  it('replaces single cell placeholder', async () => {
    const tpl = await buildTemplate('simple.xlsx', (ws) => {
      ws.getCell('A1').value = 'Name:'
      ws.getCell('B1').value = '{{name}}'
      ws.getCell('A2').value = 'Date:'
      ws.getCell('B2').value = '{{date}}'
    })
    const out = path.join(tmpDir, 'simple-out.xlsx')
    const result = await mergeXlsxFile(tpl, out, {
      name: '张三',
      date: '2026-04-30'
    })
    const rows = await readSheet(out)
    expect(rows).toEqual([
      ['Name:', '张三'],
      ['Date:', '2026-04-30']
    ])
    expect(result.replaced.sort()).toEqual(['date', 'name'])
    expect(result.missing).toEqual([])
  })

  it('replaces nested fields', async () => {
    const tpl = await buildTemplate('nested.xlsx', (ws) => {
      ws.getCell('A1').value = '{{user.name}} - {{user.dept}}'
    })
    const out = path.join(tmpDir, 'nested-out.xlsx')
    await mergeXlsxFile(tpl, out, {
      user: { name: 'Alice', dept: '财务部' }
    })
    const rows = await readSheet(out)
    expect(rows).toEqual([['Alice - 财务部']])
  })

  it('reports missing placeholders', async () => {
    const tpl = await buildTemplate('missing.xlsx', (ws) => {
      ws.getCell('A1').value = '{{exists}} {{missing}}'
    })
    const out = path.join(tmpDir, 'missing-out.xlsx')
    const result = await mergeXlsxFile(tpl, out, { exists: 'OK' }, { onMissing: 'error' })
    expect(result.missing).toEqual(['missing'])
  })

  it('preserves number type when cell is single placeholder', async () => {
    const tpl = await buildTemplate('numtype.xlsx', (ws) => {
      ws.getCell('A1').value = '{{amount}}'
    })
    const out = path.join(tmpDir, 'numtype-out.xlsx')
    await mergeXlsxFile(tpl, out, { amount: 12345.67 })
    const rows = await readSheet(out)
    expect(rows).toEqual([[12345.67]])
  })

  it('stringifies object value when assigned to single-placeholder cell', async () => {
    // 数据是对象时，必须字符串化避免 ExcelJS 写出 [object Object]
    const tpl = await buildTemplate('objval.xlsx', (ws) => {
      ws.getCell('A1').value = '{{obj}}'
    })
    const out = path.join(tmpDir, 'objval-out.xlsx')
    await mergeXlsxFile(tpl, out, { obj: { foo: 'bar' } })
    const rows = await readSheet(out)
    expect(rows[0][0]).toBe('{"foo":"bar"}')
  })
})

// ============ 行级循环 ============

describe('mergeXlsxFile: row loops', () => {
  it('expands single-row loop', async () => {
    const tpl = await buildTemplate('rowloop.xlsx', (ws) => {
      ws.getCell('A1').value = 'Name'
      ws.getCell('B1').value = 'Qty'
      ws.getCell('A2').value = '{{#each items}}{{name}}'
      ws.getCell('B2').value = '{{qty}}{{/each}}'
    })
    const out = path.join(tmpDir, 'rowloop-out.xlsx')
    const result = await mergeXlsxFile(tpl, out, {
      items: [
        { name: 'A', qty: 10 },
        { name: 'B', qty: 20 },
        { name: 'C', qty: 30 }
      ]
    })
    const rows = await readSheet(out)
    expect(rows).toEqual([
      ['Name', 'Qty'],
      ['A', 10],
      ['B', 20],
      ['C', 30]
    ])
    expect(result.loopExpansions).toHaveLength(1)
    expect(result.loopExpansions[0]).toMatchObject({
      kind: 'row',
      field: 'items',
      count: 3
    })
  })

  it('preserves cell styles across copies', async () => {
    const tpl = await buildTemplate('rowloop-style.xlsx', (ws) => {
      ws.getCell('A1').value = '{{#each items}}{{name}}'
      ws.getCell('B1').value = '{{qty}}{{/each}}'
      ws.getCell('A1').font = { bold: true, color: { argb: 'FFFF0000' } }
      ws.getCell('B1').alignment = { horizontal: 'right' }
    })
    const out = path.join(tmpDir, 'rowloop-style-out.xlsx')
    await mergeXlsxFile(tpl, out, {
      items: [
        { name: 'A', qty: 1 },
        { name: 'B', qty: 2 }
      ]
    })
    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(out)
    const ws = wb.getWorksheet('Sheet1')!
    expect(ws.getCell('A1').font?.bold).toBe(true)
    expect(ws.getCell('A2').font?.bold).toBe(true)
    expect(ws.getCell('B1').alignment?.horizontal).toBe('right')
    expect(ws.getCell('B2').alignment?.horizontal).toBe('right')
  })

  it('shifts relative formula references row by row', async () => {
    const tpl = await buildTemplate('rowloop-formula.xlsx', (ws) => {
      ws.getCell('A1').value = 'Price'
      ws.getCell('B1').value = 'Qty'
      ws.getCell('C1').value = 'Total'
      ws.getCell('A2').value = '{{#each items}}{{price}}'
      ws.getCell('B2').value = '{{qty}}'
      ws.getCell('C2').value = { formula: 'A2*B2' } as never
      // /each marker must appear in the same row to be detected as row loop
      ws.getCell('D2').value = '{{/each}}'
    })
    const out = path.join(tmpDir, 'rowloop-formula-out.xlsx')
    await mergeXlsxFile(tpl, out, {
      items: [
        { price: 10, qty: 2 },
        { price: 20, qty: 3 }
      ]
    })
    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(out)
    const ws = wb.getWorksheet('Sheet1')!
    // 第一行：A2*B2
    const c2 = ws.getCell('C2').value as { formula?: string }
    expect(c2.formula).toBe('A2*B2')
    // 第二行：偏移到 A3*B3
    const c3 = ws.getCell('C3').value as { formula?: string }
    expect(c3.formula).toBe('A3*B3')
  })

  it('@index1 inside row loop', async () => {
    const tpl = await buildTemplate('rowloop-index.xlsx', (ws) => {
      ws.getCell('A1').value = '{{#each items}}{{@index1}}'
      ws.getCell('B1').value = '{{this}}{{/each}}'
    })
    const out = path.join(tmpDir, 'rowloop-index-out.xlsx')
    await mergeXlsxFile(tpl, out, { items: ['x', 'y'] })
    const rows = await readSheet(out)
    expect(rows).toEqual([
      [1, 'x'],
      [2, 'y']
    ])
  })
})
