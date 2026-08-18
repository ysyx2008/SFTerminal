/**
 * Word 技能兼容新版 WPS 文字：打开/新建保持原后缀，老格式提示另存
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import JSZip from 'jszip'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(path.join(os.tmpdir(), 'sailfish-word-wps-ud')),
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false
  }
}))

import { executeWordTool } from '../executor'
import { closeAllSessions, isSessionOpen } from '../session'
import type { ToolExecutorConfig } from '../../../tools/types'
import type { AgentConfig } from '../../../types'

function makeExecutor(): ToolExecutorConfig {
  return {
    addStep: vi.fn().mockImplementation((step) => ({ ...step, id: 's1', timestamp: Date.now() })),
    waitForConfirmation: vi.fn().mockResolvedValue(true),
  } as unknown as ToolExecutorConfig
}

const emptyConfig = {} as AgentConfig
const tmpFiles: string[] = []

afterEach(async () => {
  await closeAllSessions()
  for (const file of tmpFiles.splice(0)) {
    try { fs.unlinkSync(file) } catch { /* ignore */ }
  }
})

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

describe('Word skill WPS compatibility', () => {
  it('word_open 能打开新版 .wps 并抽出正文', async () => {
    const filePath = path.join(os.tmpdir(), `word-open-${Date.now()}.wps`)
    await writeMinimalDocx(filePath, 'Word技能打开的WPS')

    const result = await executeWordTool('word_open', 'pty1', { path: filePath }, 'tc1', emptyConfig, makeExecutor())
    expect(result.success).toBe(true)
    expect(result.output).toContain('Word技能打开的WPS')
    expect(isSessionOpen(filePath)).toBe(true)
    expect(isSessionOpen(`${filePath}.docx`)).toBe(false)
  })

  it('word_open 遇到老格式 .wps 应提示另存，不打开会话', async () => {
    const filePath = path.join(os.tmpdir(), `word-legacy-${Date.now()}.wps`)
    fs.writeFileSync(filePath, Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00, 0x00]))
    tmpFiles.push(filePath)

    const result = await executeWordTool('word_open', 'pty1', { path: filePath }, 'tc1', emptyConfig, makeExecutor())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/另存为 Word/)
    expect(isSessionOpen(filePath)).toBe(false)
  })

  it('word_create 路径已是 .wps 时不改成 .wps.docx', async () => {
    const filePath = path.join(os.tmpdir(), `word-create-${Date.now()}.wps`)
    tmpFiles.push(filePath)
    tmpFiles.push(`${filePath}.docx`)

    const result = await executeWordTool('word_create', 'pty1', { path: filePath }, 'tc1', emptyConfig, makeExecutor())
    expect(result.success).toBe(true)
    expect(result.output).toContain(filePath)
    expect(result.output).not.toContain(`${filePath}.docx`)
    expect(isSessionOpen(filePath)).toBe(true)
    expect(isSessionOpen(`${filePath}.docx`)).toBe(false)
  })

  it('word_merge_template 接受 .wps 模板', async () => {
    const template = path.join(os.tmpdir(), `word-tpl-${Date.now()}.wps`)
    const output = path.join(os.tmpdir(), `word-out-${Date.now()}.docx`)
    tmpFiles.push(output)
    await writeMinimalDocx(template, '你好 {{name}}')

    const result = await executeWordTool(
      'word_merge_template',
      'pty1',
      { template, output, data: { name: '旗鱼' } },
      'tc1',
      emptyConfig,
      makeExecutor()
    )
    expect(result.success).toBe(true)
    expect(fs.existsSync(output)).toBe(true)
  })

  it('word_export_pdf 仍只接受 .docx', async () => {
    const filePath = path.join(os.tmpdir(), `word-pdf-${Date.now()}.wps`)
    await writeMinimalDocx(filePath, '不能直接导出')

    const result = await executeWordTool('word_export_pdf', 'pty1', { path: filePath }, 'tc1', emptyConfig, makeExecutor())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/docx/i)
  })
})
