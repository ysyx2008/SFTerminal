/**
 * Excel 技能兼容新版 WPS 表格：打开/生成保持原后缀，老格式提示另存
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(path.join(os.tmpdir(), 'sailfish-excel-wps-ud')),
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false
  }
}))

import { executeExcelTool } from '../executor'
import { closeAllSessions, isSessionOpen } from '../session'
import type { ToolExecutorConfig } from '../../../tools/types'
import type { AgentConfig } from '../../../types'

function makeExecutor(): ToolExecutorConfig {
  return {
    addStep: vi.fn().mockImplementation((step) => ({ ...step, id: 's1', timestamp: Date.now() })),
    waitForConfirmation: vi.fn().mockResolvedValue(true),
  } as unknown as ToolExecutorConfig
}

const emptyConfig = { executionMode: 'free' } as AgentConfig
const tmpFiles: string[] = []

afterEach(async () => {
  await closeAllSessions()
  for (const file of tmpFiles.splice(0)) {
    try { fs.unlinkSync(file) } catch { /* ignore */ }
  }
})

async function writeEt(filePath: string, rows: Array<Array<string | number>>): Promise<void> {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sheet1')
  for (const row of rows) sheet.addRow(row)
  await workbook.xlsx.writeFile(filePath)
  tmpFiles.push(filePath)
}

describe('Excel skill WPS compatibility', () => {
  it('excel_open 能打开新版 .et', async () => {
    const filePath = path.join(os.tmpdir(), `excel-open-${Date.now()}.et`)
    await writeEt(filePath, [['品名', '数量'], ['苹果', 9]])

    const result = await executeExcelTool('excel_open', 'pty1', { path: filePath }, 'tc1', emptyConfig, makeExecutor())
    expect(result.success).toBe(true)
    expect(result.output).toContain('Sheet1')
    expect(isSessionOpen(filePath)).toBe(true)
    expect(isSessionOpen(`${filePath}.xlsx`)).toBe(false)
  })

  it('excel_open 遇到老格式 .et 应提示另存，不打开会话', async () => {
    const filePath = path.join(os.tmpdir(), `excel-legacy-${Date.now()}.et`)
    fs.writeFileSync(filePath, Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00, 0x00]))
    tmpFiles.push(filePath)

    const result = await executeExcelTool('excel_open', 'pty1', { path: filePath }, 'tc1', emptyConfig, makeExecutor())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/另存为 Excel/)
    expect(isSessionOpen(filePath)).toBe(false)
  })

  it('excel_from_markdown 路径已是 .et 时不改成 .et.xlsx', async () => {
    const filePath = path.join(os.tmpdir(), `excel-md-${Date.now()}.et`)
    tmpFiles.push(filePath)
    tmpFiles.push(`${filePath}.xlsx`)

    const result = await executeExcelTool(
      'excel_from_markdown',
      'pty1',
      { path: filePath, markdown: '| 列A | 列B |\n| --- | --- |\n| 1 | 2 |' },
      'tc1',
      emptyConfig,
      makeExecutor()
    )
    expect(result.success).toBe(true)
    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.existsSync(`${filePath}.xlsx`)).toBe(false)
  })

  it('excel_merge_template 接受 .et 模板', async () => {
    const template = path.join(os.tmpdir(), `excel-tpl-${Date.now()}.et`)
    const output = path.join(os.tmpdir(), `excel-out-${Date.now()}.xlsx`)
    tmpFiles.push(output)
    await writeEt(template, [['你好 {{name}}']])

    const result = await executeExcelTool(
      'excel_merge_template',
      'pty1',
      { template, output, data: { name: '旗鱼' } },
      'tc1',
      emptyConfig,
      makeExecutor()
    )
    expect(result.success).toBe(true)
    expect(fs.existsSync(output)).toBe(true)
  })
})
