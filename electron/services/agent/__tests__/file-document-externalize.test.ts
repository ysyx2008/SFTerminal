/**
 * read_file 文档解析路径「落盘 + 指针」测试（C2）
 *
 * PDF/Word 解析出的文本不在磁盘上、range 参数对解析内容不生效，
 * 超预算时必须全文落盘 scratch 换指针，禁止截断（截断即永久丢失）。
 */
import { describe, it, expect, vi, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const TEST_USERDATA = path.join(os.tmpdir(), 'sailfish-doc-externalize-test')
const TEST_DIR = path.join(os.tmpdir(), 'sailfish-doc-externalize-src')

const { PARSED_CONTENT } = vi.hoisted(() => ({
  PARSED_CONTENT: '第一页正文。\n'.repeat(4000) + '最后一页结论。\n'
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockImplementation(() => TEST_USERDATA),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('../../document-parser.service', () => ({
  getDocumentParserService: () => ({
    parseDocument: vi.fn().mockResolvedValue({ content: PARSED_CONTENT, pageCount: 10 })
  })
}))

import { readFile } from '../tools/file'
import type { ToolExecutorConfig } from '../tools/types'
import type { ToolOutputBudget } from '../tool-output-budget'

const PDF_PATH = path.join(TEST_DIR, 'big.pdf')

function makeExecutor(maxChars: number): ToolExecutorConfig {
  const budget: ToolOutputBudget = { maxChars, maxLines: 500, critical: false, usagePercent: 60 }
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
    getToolOutputBudget: () => budget
  } as unknown as ToolExecutorConfig
}

afterAll(() => {
  fs.rmSync(TEST_USERDATA, { recursive: true, force: true })
  fs.rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('read_file 文档解析路径：超预算落盘 + 指针', () => {
  it('解析文本超预算 → 全文落盘 scratch，返回指针 + 头部摘录，不截断', async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true })
    fs.writeFileSync(PDF_PATH, '%PDF-fake') // 内容不会被读，parser 已 mock

    const result = await readFile('pty1', { path: PDF_PATH }, {} as never, makeExecutor(1000))

    expect(result.success).toBe(true)
    // 返回的是指针而非全文：不含结尾内容
    expect(result.output).not.toContain('最后一页结论')
    // 指针里的路径可读回完整解析文本
    const match = result.output.match(/\/[^\n]*?tool-outputs[^\n]*?\.txt/)
    expect(match).not.toBeNull()
    const savedPath = match![0]
    expect(fs.readFileSync(savedPath, 'utf-8')).toBe(PARSED_CONTENT)
  })

  it('解析文本在预算内 → 原样返回（短输出零打扰）', async () => {
    const result = await readFile('pty1', { path: PDF_PATH }, {} as never, makeExecutor(10_000_000))
    expect(result.success).toBe(true)
    expect(result.output).toContain('最后一页结论')
  })

  it('上下文余量耗尽（maxChars=0）→ 返回错误引导先压缩，与普通文件路径一致（不落盘空指针）', async () => {
    const result = await readFile('pty1', { path: PDF_PATH }, {} as never, makeExecutor(0))
    expect(result.success).toBe(false)
    expect(result.error).toContain('compress_context')
    expect(result.error).toContain(PDF_PATH)
  })
})
