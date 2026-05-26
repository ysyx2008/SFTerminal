import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  cellValuesMatch,
  formatCellValue,
  validateExpectedOriginals
} from '../cell-value'

describe('formatCellValue / cellValuesMatch', () => {
  it('treats null and undefined as empty', () => {
    expect(formatCellValue(null)).toBe('')
    expect(cellValuesMatch('', null)).toBe(true)
    expect(cellValuesMatch('', undefined)).toBe(true)
  })

  it('matches plain text and numbers', () => {
    expect(cellValuesMatch('序号', '序号')).toBe(true)
    expect(cellValuesMatch(1, 1)).toBe(true)
    expect(cellValuesMatch('1', 1)).toBe(true)
  })

  it('rejects mismatch', () => {
    expect(cellValuesMatch('序号', '说明')).toBe(false)
    expect(cellValuesMatch('', '已有数据')).toBe(false)
  })

  it('compares formula by result when present', () => {
    expect(cellValuesMatch(10, { formula: 'SUM(A1:A2)', result: 10 })).toBe(true)
  })
})

describe('validateExpectedOriginals', () => {
  let tmpDir: string

  it('detects header row mismatch on real workbook', async () => {
    const ExcelJS = await import('exceljs')
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-excel-cas-'))
    const fp = path.join(tmpDir, 't.xlsx')
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet1')
    ws.getCell('A1').value = '填表说明'
    ws.getCell('A2').value = '序号'
    ws.getCell('A3').value = ''
    await wb.xlsx.writeFile(fp)

    const wb2 = new ExcelJS.Workbook()
    await wb2.xlsx.readFile(fp)
    const sheet = wb2.getWorksheet('Sheet1')!

    const ok = validateExpectedOriginals(sheet, { A2: '序号', A3: '' })
    expect(ok).toHaveLength(0)

    const bad = validateExpectedOriginals(sheet, { A1: '序号', A2: '' })
    expect(bad).toHaveLength(2)
    expect(bad[0].ref).toBe('A1')
    expect(bad[0].actual).toContain('填表说明')

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
