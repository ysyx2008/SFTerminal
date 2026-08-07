/**
 * exec / command 工具输出预算接入测试（2026-08-06 起：截断 → 落盘 + 指针）
 *
 * 验证：输出超上限（min(动态预算, 16KB)）时，exec.formatTaskOutput 与
 * command.applyCommandOutputBudget 把全文落盘 scratch/tool-outputs/，
 * 返回「指针 notice + 尾部摘录」；预算内原样返回；无预算回退 16KB 上限。
 */
import { describe, it, expect, vi, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const TEST_USERDATA = path.join(os.tmpdir(), 'sailfish-cmd-externalize-test')

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockImplementation(() => TEST_USERDATA),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  }
}))

import { formatTaskOutput } from '../tools/exec'
import { applyCommandOutputBudget } from '../tools/command'
import type { ToolExecutorConfig } from '../tools/types'
import type { ToolOutputBudget } from '../tool-output-budget'

// ==================== 工具：构造 mock executor ====================

function makeExecutor(budget?: ToolOutputBudget): ToolExecutorConfig {
  return {
    getToolOutputBudget: budget ? () => budget : undefined,
  } as unknown as ToolExecutorConfig
}

/** 生成 n 行文本，每行约 80 字符 */
function makeLongOutput(lines: number): string {
  const line = 'x'.repeat(80)
  return Array.from({ length: lines }, () => line).join('\n')
}

/** 从指针文本中提取落盘文件路径并读回全文 */
function readExternalized(out: string): string {
  const match = out.match(/\/[^\n]*?tool-outputs[^\n]*?\.txt/)
  expect(match).not.toBeNull()
  return fs.readFileSync(match![0], 'utf-8')
}

afterAll(() => {
  fs.rmSync(TEST_USERDATA, { recursive: true, force: true })
})

// ==================== exec.formatTaskOutput ====================

describe('exec.formatTaskOutput — 落盘 + 指针', () => {
  it('无预算 → 超 16KB 落盘换指针（向后兼容上限）', async () => {
    const long = makeLongOutput(500) // 500 * 81 ≈ 40KB > 16KB
    const out = await formatTaskOutput(long, makeExecutor(undefined))
    expect(out.length).toBeLessThan(long.length)
    expect(out.length).toBeLessThanOrEqual(16_384 + 500) // 指针 + 摘录仍在预算附近
    expect(readExternalized(out)).toBe(long.trim()) // 全文可读回，不丢
  })

  it('预算大于 16KB → 仍按 16KB 分界落盘（不放大）', async () => {
    const long = makeLongOutput(500)
    const out = await formatTaskOutput(long, makeExecutor({ maxChars: 100_000, maxLines: 1000, critical: false, usagePercent: 50 }))
    expect(out.length).toBeLessThanOrEqual(16_384 + 500)
    expect(readExternalized(out)).toBe(long.trim())
  })

  it('预算小于 16KB（上下文紧张）→ 按预算收紧摘录', async () => {
    const long = makeLongOutput(500)
    const tightBudget: ToolOutputBudget = { maxChars: 2_000, maxLines: 20, critical: true, usagePercent: 90 }
    const out = await formatTaskOutput(long, makeExecutor(tightBudget))
    expect(out.length).toBeLessThanOrEqual(2_000 + 500) // 远小于 16KB
    expect(out.length).toBeLessThan(16_384)
    expect(readExternalized(out)).toBe(long.trim())
  })

  it('预算 maxChars=0（上下文几乎满）→ 回退 16KB 分界（不给零预算）', async () => {
    const long = makeLongOutput(500)
    const fullBudget: ToolOutputBudget = { maxChars: 0, maxLines: 0, critical: true, usagePercent: 99 }
    const out = await formatTaskOutput(long, makeExecutor(fullBudget))
    // maxChars=0 → 仍走 OUTPUT_TRUNCATE 兜底（budget.maxChars>0 才生效，否则回退 16KB）
    expect(out.length).toBeLessThanOrEqual(16_384 + 500)
    expect(readExternalized(out)).toBe(long.trim())
  })

  it('短输出（< 预算）→ 原样返回（仅 trim）', async () => {
    const short = 'hello world'
    const out = await formatTaskOutput(short, makeExecutor({ maxChars: 2_000, maxLines: 20, critical: false, usagePercent: 50 }))
    expect(out).toBe('hello world')
  })

  it('超预算时保留尾部摘录（命令结论通常在末尾），不含头部', async () => {
    const lines = ['HEAD_LINE_1', ...Array.from({ length: 300 }, (_, i) => `BODY_${i}`), 'TAIL_LINE_END']
    const raw = lines.join('\n')
    const tightBudget: ToolOutputBudget = { maxChars: 2_000, maxLines: 20, critical: true, usagePercent: 90 }
    const out = await formatTaskOutput(raw, makeExecutor(tightBudget))
    expect(out).toContain('TAIL_LINE_END')
    expect(out).not.toContain('HEAD_LINE_1')
    // 全文含头部，可读回
    expect(readExternalized(out)).toContain('HEAD_LINE_1')
  })
})

// ==================== command.applyCommandOutputBudget ====================

describe('command.applyCommandOutputBudget — 落盘 + 指针', () => {
  it('无预算 → 超 16KB 落盘换指针', async () => {
    const long = makeLongOutput(500)
    const out = await applyCommandOutputBudget(long, makeExecutor(undefined))
    expect(out.length).toBeLessThan(long.length)
    expect(out.length).toBeLessThanOrEqual(16_384 + 500)
    expect(readExternalized(out)).toBe(long.trim())
  })

  it('预算大于 16KB → 仍按 16KB 分界落盘', async () => {
    const long = makeLongOutput(500)
    const out = await applyCommandOutputBudget(long, makeExecutor({ maxChars: 100_000, maxLines: 1000, critical: false, usagePercent: 50 }))
    expect(out.length).toBeLessThanOrEqual(16_384 + 500)
    expect(readExternalized(out)).toBe(long.trim())
  })

  it('预算小于 16KB（上下文紧张）→ 按预算收紧摘录', async () => {
    const long = makeLongOutput(500)
    const tightBudget: ToolOutputBudget = { maxChars: 2_000, maxLines: 20, critical: true, usagePercent: 90 }
    const out = await applyCommandOutputBudget(long, makeExecutor(tightBudget))
    expect(out.length).toBeLessThanOrEqual(2_000 + 500)
    expect(out.length).toBeLessThan(16_384)
    expect(readExternalized(out)).toBe(long.trim())
  })

  it('预算 maxChars=0 → 回退到 16KB（与 exec 一致：不给零预算）', async () => {
    const long = makeLongOutput(500)
    const fullBudget: ToolOutputBudget = { maxChars: 0, maxLines: 0, critical: true, usagePercent: 99 }
    const out = await applyCommandOutputBudget(long, makeExecutor(fullBudget))
    expect(out.length).toBeLessThanOrEqual(16_384 + 500)
    expect(readExternalized(out)).toBe(long.trim())
  })

  it('短输出（< 预算）→ 原样返回', async () => {
    const short = 'command output here'
    const out = await applyCommandOutputBudget(short, makeExecutor({ maxChars: 2_000, maxLines: 20, critical: false, usagePercent: 50 }))
    expect(out).toBe('command output here')
  })

  it('超预算时保留尾部摘录，不含头部', async () => {
    const lines = ['CMD_HEAD', ...Array.from({ length: 300 }, (_, i) => `MIDDLE_${i}`), 'CMD_TAIL']
    const raw = lines.join('\n')
    const tightBudget: ToolOutputBudget = { maxChars: 2_000, maxLines: 20, critical: true, usagePercent: 90 }
    const out = await applyCommandOutputBudget(raw, makeExecutor(tightBudget))
    expect(out).toContain('CMD_TAIL')
    expect(out).not.toContain('CMD_HEAD')
    expect(readExternalized(out)).toContain('CMD_HEAD')
  })
})

// ==================== 一致性：exec 与 command 行为对齐 ====================

describe('exec 与 command 输出预算行为一致', () => {
  it('相同输入 + 相同预算 → 返回长度相当', async () => {
    const long = makeLongOutput(300)
    const budget: ToolOutputBudget = { maxChars: 4_000, maxLines: 40, critical: false, usagePercent: 60 }
    const execOut = await formatTaskOutput(long, makeExecutor(budget))
    const cmdOut = await applyCommandOutputBudget(long, makeExecutor(budget))
    // 两者都会 trim 首尾空白；输入已无首尾空白，长度应接近
    expect(Math.abs(execOut.length - cmdOut.length)).toBeLessThan(50)
  })
})
