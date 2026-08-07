/**
 * tool-output-externalize 单元测试
 *
 * 验证「长输出落盘 + 指针」契约：
 * - 预算内 / 空输出 → null（调用方原样返回，短输出零打扰）
 * - 超预算 → 全文落盘 scratch/tool-outputs/，返回指针 notice + 摘录（head/tail）
 * - 上下文余量耗尽（maxChars <= 0）→ 只给指针不附摘录
 * - 落盘失败 → 抛错（禁止退回截断），错误文案含缩小范围建议
 */
import { describe, it, expect, vi, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const TEST_USERDATA = path.join(os.tmpdir(), 'sailfish-externalize-test')

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockImplementation(() => TEST_USERDATA),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  }
}))

import { externalizeToolOutput, externalizeFailedError } from '../tool-output-externalize'
import type { ToolOutputBudget } from '../tool-output-budget'

const budget = (maxChars: number): ToolOutputBudget => ({
  maxChars,
  maxLines: 100,
  critical: false,
  usagePercent: 50
})

afterAll(() => {
  fs.rmSync(TEST_USERDATA, { recursive: true, force: true })
})

describe('externalizeToolOutput', () => {
  it('预算内返回 null（短输出不落盘）', () => {
    const result = externalizeToolOutput({
      output: 'short output',
      budget: budget(1000),
      toolName: 'read_file',
      excerpt: 'head'
    })
    expect(result).toBeNull()
  })

  it('空输出返回 null', () => {
    expect(externalizeToolOutput({ output: '', budget: budget(0), toolName: 'exec', excerpt: 'tail' })).toBeNull()
  })

  it('超预算 → 全文落盘 + 指针含路径 + 头部摘录', () => {
    const output = 'A'.repeat(500) + 'B'.repeat(500)
    const result = externalizeToolOutput({
      output,
      budget: budget(500),
      toolName: 'read_file',
      excerpt: 'head'
    })
    expect(result).not.toBeNull()
    // 全文落盘
    expect(fs.readFileSync(result!.filePath, 'utf-8')).toBe(output)
    expect(result!.filePath).toContain('tool-outputs')
    // 指针 notice 含路径与总字符数
    expect(result!.text).toContain(result!.filePath)
    expect(result!.totalChars).toBe(1000)
    // 头部摘录：maxChars - notice 预留 = 100 字符，全是 A
    expect(result!.text).toContain('A'.repeat(100))
    expect(result!.text).not.toContain('B'.repeat(100))
  })

  it('tail 摘录取末尾内容', () => {
    const output = 'A'.repeat(500) + 'B'.repeat(500)
    const result = externalizeToolOutput({
      output,
      budget: budget(500),
      toolName: 'exec',
      excerpt: 'tail'
    })
    expect(result).not.toBeNull()
    expect(result!.text).toContain('B'.repeat(100))
    expect(fs.readFileSync(result!.filePath, 'utf-8')).toBe(output)
  })

  it('maxChars <= 0（余量耗尽）→ 落盘但只给指针', () => {
    const output = 'X'.repeat(100)
    const result = externalizeToolOutput({
      output,
      budget: budget(0),
      toolName: 'exec',
      excerpt: 'tail'
    })
    expect(result).not.toBeNull()
    expect(fs.readFileSync(result!.filePath, 'utf-8')).toBe(output)
    expect(result!.text).toContain(result!.filePath)
    // 不附摘录：正文内容不出现在指针文本里
    expect(result!.text).not.toContain('X'.repeat(50))
  })

  it('落盘失败抛错（禁止退回截断）', () => {
    // 把当日的日期子目录占位成文件，使 mkdir 失败，模拟真实 IO 故障
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const outputsDir = path.join(TEST_USERDATA, 'agent-workspace', 'scratch', 'tool-outputs')
    const blocker = path.join(outputsDir, day)
    fs.rmSync(blocker, { recursive: true, force: true })
    fs.mkdirSync(outputsDir, { recursive: true })
    fs.writeFileSync(blocker, 'not a dir')
    try {
      expect(() => externalizeToolOutput({
        output: 'A'.repeat(100),
        budget: budget(10),
        toolName: 'exec',
        excerpt: 'tail'
      })).toThrow()
    } finally {
      fs.rmSync(blocker, { force: true })
    }
  })

  it('externalizeFailedError 文案含字符数与原因', () => {
    const msg = externalizeFailedError(12345, 'disk full')
    expect(msg).toContain('12,345')
    expect(msg).toContain('disk full')
  })
})
