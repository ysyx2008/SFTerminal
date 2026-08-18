/**
 * read_file 对 WPS 文字/表格走文档解析，而不是当二进制乱读
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import JSZip from 'jszip'

const TEST_USERDATA = path.join(os.tmpdir(), 'sailfish-read-file-wps-ud')

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockImplementation(() => TEST_USERDATA),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

import { readFile } from '../tools/file'
import type { ToolExecutorConfig } from '../tools/types'

function makeExecutor(): ToolExecutorConfig {
  return {
    terminalService: {} as ToolExecutorConfig['terminalService'],
    addStep: vi.fn().mockImplementation((step) => ({ ...step, id: 's1', timestamp: Date.now() })),
    updateStep: vi.fn(),
    waitForConfirmation: vi.fn(),
    requestSecureInput: vi.fn(),
    isAborted: () => false,
    getHostId: () => undefined,
    hasPendingUserMessage: () => false,
    peekPendingUserMessage: () => undefined,
    consumePendingUserMessage: () => undefined,
    getRealtimeTerminalOutput: () => [],
    getCurrentPlan: () => undefined,
    setCurrentPlan: vi.fn(),
    getTaskMemory: vi.fn(),
    getToolOutputBudget: () => ({ maxChars: 50_000, maxLines: 2000, critical: false, usagePercent: 10 })
  } as unknown as ToolExecutorConfig
}

async function writeMinimalDocx(filePath: string, text: string): Promise<void> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>'
  )
  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>'
  )
  zip.file('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
  )
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }))
}

const tmpFiles: string[] = []

afterAll(() => {
  for (const file of tmpFiles) {
    try { fs.unlinkSync(file) } catch { /* ignore */ }
  }
  fs.rmSync(TEST_USERDATA, { recursive: true, force: true })
})

describe('read_file WPS', () => {
  it('新版 WPS 文字应抽出正文', async () => {
    const filePath = path.join(os.tmpdir(), `read-wps-${Date.now()}.wps`)
    tmpFiles.push(filePath)
    await writeMinimalDocx(filePath, 'read_file读到的WPS')

    const result = await readFile('pty1', { path: filePath }, {} as never, makeExecutor())
    expect(result.success).toBe(true)
    expect(result.output).toContain('read_file读到的WPS')
    expect(result.error).toBeUndefined()
  })

  it('新版 WPS 表格应抽出正文', async () => {
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('库存')
    sheet.addRow(['货物', '件数'])
    sheet.addRow(['纸箱', 7])
    const filePath = path.join(os.tmpdir(), `read-et-${Date.now()}.et`)
    tmpFiles.push(filePath)
    await workbook.xlsx.writeFile(filePath)

    const result = await readFile('pty1', { path: filePath }, {} as never, makeExecutor())
    expect(result.success).toBe(true)
    expect(result.output).toContain('纸箱')
    expect(result.output).toContain('7')
  })

  it('老格式 WPS 文字应失败并提示另存，不给乱码', async () => {
    const filePath = path.join(os.tmpdir(), `read-legacy-wps-${Date.now()}.wps`)
    tmpFiles.push(filePath)
    fs.writeFileSync(filePath, Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00, 0x00]))

    const result = await readFile('pty1', { path: filePath }, {} as never, makeExecutor())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/另存为 Word/)
    expect(result.output).toBe('')
  })
})
