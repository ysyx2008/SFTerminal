/**
 * exec / command 工具输出预算接入测试
 *
 * 验证：当 executor 提供 getToolOutputBudget（上下文紧张时收紧）时，
 * exec.formatTaskOutput 与 command.applyCommandOutputBudget 会按预算截断输出；
 * 无预算时回退到 16KB 上限（保持向后兼容）。
 */
import { describe, it, expect } from 'vitest'
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

// ==================== exec.formatTaskOutput ====================

describe('exec.formatTaskOutput — 输出预算接入', () => {
  it('无预算 → 回退到 16KB 上限（向后兼容）', () => {
    const long = makeLongOutput(500) // 500 * 81 ≈ 40KB > 16KB
    const out = formatTaskOutput(long, makeExecutor(undefined))
    expect(out.length).toBeLessThan(long.length)
    expect(out.length).toBeLessThanOrEqual(16_384 + 500) // 含截断提示文案
    expect(out).toMatch(/截断|truncated/i) // sandwich 截断提示
  })

  it('预算大于 16KB → 仍按 16KB 截断（不放大）', () => {
    const long = makeLongOutput(500)
    const out = formatTaskOutput(long, makeExecutor({ maxChars: 100_000, maxLines: 1000, critical: false }))
    // maxChars 取 min(100000, 16384) = 16384
    expect(out.length).toBeLessThanOrEqual(16_384 + 500)
  })

  it('预算小于 16KB（上下文紧张）→ 按预算收紧', () => {
    const long = makeLongOutput(500)
    const tightBudget: ToolOutputBudget = { maxChars: 2_000, maxLines: 20, critical: true }
    const out = formatTaskOutput(long, makeExecutor(tightBudget))
    expect(out.length).toBeLessThanOrEqual(2_000 + 500) // 远小于 16KB
    expect(out.length).toBeLessThan(16_384)
  })

  it('预算 maxChars=0（上下文几乎满）→ 输出极短（不爆）', () => {
    const long = makeLongOutput(500)
    const fullBudget: ToolOutputBudget = { maxChars: 0, maxLines: 0, critical: true }
    const out = formatTaskOutput(long, makeExecutor(fullBudget))
    // maxChars=0 → 仍走 OUTPUT_TRUNCATE 兜底（min(0,16384) 逻辑里 budget.maxChars>0 才生效，
    // 否则回退 16KB）。这是设计：完全为 0 时仍给最小可用输出而非完全静默。
    // 见 exec.ts: budget && budget.maxChars > 0 ? min : OUTPUT_TRUNCATE
    expect(out.length).toBeLessThanOrEqual(16_384 + 500)
  })

  it('短输出（< 预算）→ 原样返回（仅 trim）', () => {
    const short = 'hello world'
    const out = formatTaskOutput(short, makeExecutor({ maxChars: 2_000, maxLines: 20, critical: false }))
    expect(out).toBe('hello world')
  })

  it('预算收紧时保留头尾（sandwich 截断）', () => {
    // 构造头尾特征明显的输出
    const lines = ['HEAD_LINE_1', 'BODY_1', 'BODY_2', 'BODY_3', 'BODY_4', 'TAIL_LINE_6']
    const raw = lines.join('\n')
    const tightBudget: ToolOutputBudget = { maxChars: 30, maxLines: 2, critical: true }
    const out = formatTaskOutput(raw, makeExecutor(tightBudget))
    // 头尾应保留
    expect(out).toContain('HEAD_LINE_1')
    expect(out).toContain('TAIL_LINE_6')
    // 中间被省略
    expect(out).not.toContain('BODY_3')
  })
})

// ==================== command.applyCommandOutputBudget ====================

describe('command.applyCommandOutputBudget — 输出预算接入', () => {
  it('无预算 → 回退到 16KB 上限（向后兼容）', () => {
    const long = makeLongOutput(500)
    const out = applyCommandOutputBudget(long, makeExecutor(undefined))
    expect(out.length).toBeLessThan(long.length)
    expect(out.length).toBeLessThanOrEqual(16_384 + 500)
  })

  it('预算大于 16KB → 仍按 16KB 截断', () => {
    const long = makeLongOutput(500)
    const out = applyCommandOutputBudget(long, makeExecutor({ maxChars: 100_000, maxLines: 1000, critical: false }))
    expect(out.length).toBeLessThanOrEqual(16_384 + 500)
  })

  it('预算小于 16KB（上下文紧张）→ 按预算收紧', () => {
    const long = makeLongOutput(500)
    const tightBudget: ToolOutputBudget = { maxChars: 2_000, maxLines: 20, critical: true }
    const out = applyCommandOutputBudget(long, makeExecutor(tightBudget))
    expect(out.length).toBeLessThanOrEqual(2_000 + 500)
    expect(out.length).toBeLessThan(16_384)
  })

  it('预算 maxChars=0 → 回退到 16KB（与 exec 一致：不给零预算）', () => {
    const long = makeLongOutput(500)
    const fullBudget: ToolOutputBudget = { maxChars: 0, maxLines: 0, critical: true }
    const out = applyCommandOutputBudget(long, makeExecutor(fullBudget))
    expect(out.length).toBeLessThanOrEqual(16_384 + 500)
  })

  it('短输出（< 预算）→ 原样返回', () => {
    const short = 'command output here'
    const out = applyCommandOutputBudget(short, makeExecutor({ maxChars: 2_000, maxLines: 20, critical: false }))
    expect(out).toBe('command output here')
  })

  it('预算收紧时保留头尾（sandwich 截断）', () => {
    const lines = ['CMD_HEAD', 'MIDDLE_1', 'MIDDLE_2', 'MIDDLE_3', 'CMD_TAIL']
    const raw = lines.join('\n')
    const tightBudget: ToolOutputBudget = { maxChars: 30, maxLines: 2, critical: true }
    const out = applyCommandOutputBudget(raw, makeExecutor(tightBudget))
    expect(out).toContain('CMD_HEAD')
    expect(out).toContain('CMD_TAIL')
    expect(out).not.toContain('MIDDLE_2')
  })
})

// ==================== 一致性：exec 与 command 行为对齐 ====================

describe('exec 与 command 输出预算行为一致', () => {
  it('相同输入 + 相同预算 → 截断长度相当', () => {
    const long = makeLongOutput(300)
    const budget: ToolOutputBudget = { maxChars: 4_000, maxLines: 40, critical: false }
    const execOut = formatTaskOutput(long, makeExecutor(budget))
    const cmdOut = applyCommandOutputBudget(long, makeExecutor(budget))
    // 注意：exec 会 trim 首尾空白，command 不会；这里输入已无首尾空白，长度应接近
    expect(Math.abs(execOut.length - cmdOut.length)).toBeLessThan(50)
  })
})
