/**
 * exec 输出截断 helper 单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// vi.mock 的 factory 会被提升到文件顶部，不能引用外部变量；
// 用 vi.hoisted 让临时目录在 hoist 阶段就能算出来
const { tmpUserData } = vi.hoisted(() => {
  const os = require('os') as typeof import('os')
  const path = require('path') as typeof import('path')
  return { tmpUserData: path.join(os.tmpdir(), `sft-truncate-test-${process.pid}`) }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(tmpUserData),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0'),
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}))

import {
  truncateFromEndDetailed,
  truncateFromEndWithNotice,
  truncateSandwichDetailed,
  truncateSandwichWithNotice,
} from '../tools/utils'
import { executeCommandDirect } from '../tools/exec'
import { getExecManager } from '../tools/exec-manager'
import type { AgentConfig, ToolExecutorConfig } from '../tools/types'

/** 与 exec.ts 中 OUTPUT_TRUNCATE 保持一致 */
const EXEC_OUTPUT_TRUNCATE = 16_384

const isWin = process.platform === 'win32'
const itPosix = isWin ? it.skip : it

function createMinimalExecutor(): ToolExecutorConfig {
  return {
    agentId: 'test-exec-output',
    terminalService: {} as ToolExecutorConfig['terminalService'],
    addStep: vi.fn((partial) => ({
      id: 'step-1',
      timestamp: Date.now(),
      ...partial,
    })),
    updateStep: vi.fn(),
    waitForConfirmation: vi.fn().mockResolvedValue(true),
    requestSecureInput: vi.fn().mockResolvedValue(true),
    isAborted: vi.fn().mockReturnValue(false),
    getHostId: vi.fn().mockReturnValue(undefined),
    hasPendingUserMessage: vi.fn().mockReturnValue(false),
    peekPendingUserMessage: vi.fn().mockReturnValue(undefined),
    consumePendingUserMessage: vi.fn().mockReturnValue(undefined),
    getRealtimeTerminalOutput: vi.fn().mockReturnValue([]),
    getCurrentPlan: vi.fn().mockReturnValue(undefined),
    setCurrentPlan: vi.fn(),
    getTaskMemory: vi.fn() as ToolExecutorConfig['getTaskMemory'],
  }
}

const freeModeConfig: AgentConfig = {
  executionMode: 'free',
  commandTimeout: 30_000,
  aiProfileId: 'test',
  language: 'zh-CN',
} as AgentConfig

describe('truncateFromEndDetailed', () => {
  it('短文本不截断', () => {
    const result = truncateFromEndDetailed('hello', 100)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe('hello')
  })

  it('超长文本截断并保留尾部', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`)
    const input = lines.join('\n')
    const result = truncateFromEndDetailed(input, 100)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('line-199')
    expect(result.text).not.toContain('line-0\n')
  })
})

describe('truncateFromEndWithNotice', () => {
  it('未截断时不附加 notice', () => {
    const out = truncateFromEndWithNotice('ok', 10, () => 'NOTICE')
    expect(out).toBe('ok')
  })
})

describe('truncateSandwichDetailed', () => {
  it('短文本不截断', () => {
    const result = truncateSandwichDetailed('hello', 100)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe('hello')
  })

  it('多行输出同时保留开头与末尾行', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${String(i).padStart(3, '0')}`)
    const input = lines.join('\n')
    const result = truncateSandwichDetailed(input, 800)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('line-000')
    expect(result.text).toContain('line-499')
    expect(result.text).toContain('\n...\n')
    expect(result.omittedLines).toBeGreaterThan(0)
    expect(result.omittedChars).toBeGreaterThan(0)
  })

  it('单行超长内容按字符头尾截断', () => {
    const input = 'a'.repeat(500) + 'MARKER' + 'z'.repeat(500)
    const result = truncateSandwichDetailed(input, 200)
    expect(result.truncated).toBe(true)
    expect(result.text.startsWith('aaa')).toBe(true)
    expect(result.text.endsWith('zzz')).toBe(true)
    expect(result.text).toContain('\n...\n')
    expect(result.omittedLines).toBe(0)
    expect(result.omittedChars).toBeGreaterThan(0)
  })

  it('含一条超长行时优先保留前后整行', () => {
    const short = Array.from({ length: 5 }, (_, i) => `short-${i}`)
    const longLine = 'L'.repeat(10_000)
    const input = [...short, longLine, 'tail-line'].join('\n')
    const result = truncateSandwichDetailed(input, 600)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('short-0')
    expect(result.text).toContain('short-4')
    expect(result.text).toContain('tail-line')
    expect(result.text).toMatch(/^short-0\nshort-1/m)
    expect(result.shownLength).toBeLessThanOrEqual(600)
  })

  it('单行未超预算时整行保留，不因行较长而字符截断', () => {
    const longButFits = 'x'.repeat(5000)
    const input = ['head-line', longButFits, 'tail-line'].join('\n')
    const result = truncateSandwichDetailed(input, EXEC_OUTPUT_TRUNCATE)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe(input)
  })
})

describe('truncateSandwichWithNotice', () => {
  it('截断时附加 notice 行', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `row-${i}`)
    const input = lines.join('\n')
    const out = truncateSandwichWithNotice(input, 120, (s) =>
      `[total=${s.originalLength} head=${s.headChars} tail=${s.tailChars}]`
    )
    expect(out.startsWith('[total=')).toBe(true)
    expect(out).toContain('row-0')
    expect(out).toContain('row-99')
  })
})

describe('truncateSandwichDetailed — exec 16KB 预算', () => {
  it('grep 场景：首行命中与末行错误同时可见', () => {
    const head = ['./src/foo.ts:42: first grep hit']
    const middle = Array.from({ length: 800 }, (_, i) => `./src/file-${i}.ts:1: noise`)
    const tail = ['npm error code ELIFECYCLE', 'npm error command failed']
    const input = [...head, ...middle, ...tail].join('\n')
    const result = truncateSandwichDetailed(input, EXEC_OUTPUT_TRUNCATE)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('first grep hit')
    expect(result.text).toContain('npm error command failed')
    expect(result.omittedLines).toBeGreaterThan(0)
  })

  it('截断后 shownLength 不超过预算（不含后续 notice 行）', () => {
    const input = Array.from({ length: 4000 }, (_, i) => `log line ${i}`).join('\n')
    const result = truncateSandwichDetailed(input, EXEC_OUTPUT_TRUNCATE)
    expect(result.truncated).toBe(true)
    expect(result.shownLength).toBeLessThanOrEqual(EXEC_OUTPUT_TRUNCATE)
  })
})

describe('executeCommandDirect — 输出截断集成', () => {
  beforeEach(() => {
    getExecManager()._resetForTest()
  })

  afterEach(() => {
    getExecManager()._resetForTest()
  })

  itPosix('短输出不附加截断 notice', async () => {
    const result = await executeCommandDirect(
      { command: 'echo hello-exec-truncate' },
      'tc-short',
      freeModeConfig,
      createMinimalExecutor()
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('hello-exec-truncate')
    expect(result.output).not.toContain('输出已截断')
    expect(result.output).not.toContain('Output truncated')
  })

  itPosix('超长多行输出附加截断 notice 并保留头尾', async () => {
    const lineCount = 3000
    const result = await executeCommandDirect(
      {
        command: `node -e "console.log(Array.from({length:${lineCount}}, (_, i) => 'line-' + i).join('\\n'))"`,
        wait_seconds: 30,
      },
      'tc-long',
      freeModeConfig,
      createMinimalExecutor()
    )
    expect(result.success).toBe(true)
    expect(result.output).toMatch(/输出已截断|Output truncated/)
    expect(result.output).toContain('line-0')
    expect(result.output).toContain(`line-${lineCount - 1}`)
    expect(result.output).toContain('\n...\n')
  })
})
