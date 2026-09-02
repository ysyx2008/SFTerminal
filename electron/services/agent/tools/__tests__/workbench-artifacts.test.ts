import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import JSZip from 'jszip'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(path.join(os.tmpdir(), 'sailfish-wb-artifacts-ud')),
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false
  }
}))

vi.mock('../../../terminal-state.service', () => ({
  getTerminalStateService: () => ({
    getCwd: () => os.tmpdir()
  })
}))

import { manageWorkbenchArtifactsTool } from '../workbench'
import type { ToolExecutorConfig } from '../types'
import type { AgentStep, CanvasData } from '@shared/types'

const tmpFiles: string[] = []

afterEach(() => {
  for (const file of tmpFiles.splice(0)) {
    try { fs.unlinkSync(file) } catch { /* ignore */ }
  }
})

function makeExecutor(): ToolExecutorConfig & { steps: AgentStep[] } {
  const steps: AgentStep[] = []
  return {
    steps,
    addStep: vi.fn().mockImplementation((step) => {
      const full = { ...step, id: `s${steps.length + 1}`, timestamp: Date.now() } as AgentStep
      steps.push(full)
      return full
    }),
    waitForConfirmation: vi.fn().mockResolvedValue(true)
  } as unknown as ToolExecutorConfig & { steps: AgentStep[] }
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
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }))
  tmpFiles.push(filePath)
}

async function writeMinimalXlsx(filePath: string, rows: Array<Array<string | number>>): Promise<void> {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sheet1')
  for (const row of rows) sheet.addRow(row)
  await workbook.xlsx.writeFile(filePath)
  tmpFiles.push(filePath)
}

function lastCanvas(executor: { steps: AgentStep[] }): CanvasData | undefined {
  return executor.steps.at(-1)?.canvasData
}

describe('manage_workbench_artifacts open', () => {
  it('把 Word 打开进面板，生成文档预览', async () => {
    const filePath = path.join(os.tmpdir(), `wb-open-${Date.now()}.docx`)
    await writeMinimalDocx(filePath, '专项实施方案')
    const executor = makeExecutor()

    const result = await manageWorkbenchArtifactsTool(
      executor,
      { action: 'open', path: filePath },
      'pty1'
    )

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    const canvas = lastCanvas(executor)
    expect(canvas?.action).toBe('open')
    expect(canvas?.renderer).toBe('document')
    expect(canvas?.filePath).toBe(filePath)
    expect(canvas?.content).toContain('专项实施方案')
    expect(canvas?.contentFromFile).toBe(true)
  })

  it('把 Excel 打开进面板，生成表格预览', async () => {
    const filePath = path.join(os.tmpdir(), `wb-open-${Date.now()}.xlsx`)
    await writeMinimalXlsx(filePath, [['品名', '数量'], ['苹果', 9]])
    const executor = makeExecutor()

    const result = await manageWorkbenchArtifactsTool(
      executor,
      { action: 'open', path: filePath },
      'pty1'
    )

    expect(result.success).toBe(true)
    const canvas = lastCanvas(executor)
    expect(canvas?.renderer).toBe('spreadsheet')
    expect(canvas?.filePath).toBe(filePath)
    expect(canvas?.content).toMatch(/苹果|Sheet1/)
  })

  it('现成 PPT 仍不走本工具', async () => {
    const filePath = path.join(os.tmpdir(), `wb-open-${Date.now()}.pptx`)
    fs.writeFileSync(filePath, 'not-a-real-ppt')
    tmpFiles.push(filePath)
    const executor = makeExecutor()

    const result = await manageWorkbenchArtifactsTool(
      executor,
      { action: 'open', path: filePath },
      'pty1'
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/PPT/)
    expect(executor.steps).toHaveLength(0)
  })
})
