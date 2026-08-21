/**
 * 上下文预算不变量测试（SPEC: 上下文用量按实测算，不用固定经验值）
 *
 * 这三条不变量是「预算按实测算」的可验证形式。写作时刻它们**全部失败**——
 * 这正是它们存在的意义：用失败客观证明 bug 存在，修完变绿即证明修好。
 *
 * 背景实测（最小配置、无用户规则/技能/插件/MCP）：
 *   local 模式固定前缀 ≈ 17,660 tokens（system 3,380 + tools schema 14,280）
 *   assistant 模式 ≈ 19,223；ssh 模式 ≈ 14,788
 * 而代码长期按 4,000 估，低估 4.4 倍。
 */
import { describe, it, expect, vi } from 'vitest'
import { ContextWindowManager, type ContextWindowDeps } from '../context-window'
import { calculateBudget } from '../context-builder'
import type { AiMessage, ToolDefinition } from '../../ai.service'
import type { AiProfile } from '@shared/types'

const CONTEXT_LENGTH = 128000

/** 构造 N 个体积可控的工具定义，模拟真实工具集/技能/MCP 带来的固定开销 */
function makeTools(count: number, descLength = 600): ToolDefinition[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'function' as const,
    function: {
      name: `tool_${i}`,
      description: 'x'.repeat(descLength),
      parameters: {
        type: 'object',
        properties: { arg: { type: 'string', description: 'y'.repeat(descLength) } },
        required: ['arg'],
      },
    },
  }))
}

function makeDeps(overrides?: Partial<ContextWindowDeps>): ContextWindowDeps {
  return {
    config: {
      getAiProfiles: () => [{ id: 'p1', contextLength: CONTEXT_LENGTH } as AiProfile],
      getActiveAiProfile: () => 'p1',
    },
    getProfileId: () => undefined,
    getLastPromptTokens: () => undefined,
    getLastCacheHitRate: () => undefined,
    reportUsage: vi.fn(),
    ...overrides,
  }
}

// ==================== 不变量 1：固定前缀随配置浮动 ====================

describe('不变量：固定开销随实际工具集浮动', () => {
  it('工具集越大，估出来的固定开销越大', () => {
    const small = new ContextWindowManager(makeDeps({ getTools: () => makeTools(5) } as Partial<ContextWindowDeps>))
    const large = new ContextWindowManager(makeDeps({ getTools: () => makeTools(60) } as Partial<ContextWindowDeps>))

    // 同一份（空）对话，工具集大的一方必须估得更高——固定开销不能是常数
    expect(large.estimateTotalTokens([])).toBeGreaterThan(small.estimateTotalTokens([]))
  })

  it('真实规模的工具集不能只算出 4000 常数', () => {
    // 实测：local 模式 28 个内置工具的真实 prompt_tokens 贡献为 9,549
    const m = new ContextWindowManager(makeDeps({ getTools: () => makeTools(28) } as Partial<ContextWindowDeps>))
    expect(m.estimateTotalTokens([])).toBeGreaterThan(8000)
  })

  it('全量估算 = 消息体 + 工具 schema，工具那部分不能凭空消失', () => {
    const tools = makeTools(28)
    const history: AiMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: '这是一条历史消息，'.repeat(40),
    })) as AiMessage[]

    const m = new ContextWindowManager(makeDeps({ getTools: () => tools } as Partial<ContextWindowDeps>))
    const overhead = m.estimateTotalTokens(history) - m.estimateMessagesTokens(history)

    expect(overhead).toBe(m.estimateTokens(JSON.stringify(tools)))
  })
})

// ==================== 不变量 2：真实用量优先，估算只补增量 ====================

describe('不变量：有真实用量时以它为锚点', () => {
  const tools = makeTools(28)
  const history: AiMessage[] = [
    { role: 'user', content: '第一个问题' },
    { role: 'assistant', content: '第一个回答' },
  ]

  it('有锚点时不重估历史：结果 = 锚点 + 上轮响应之后的增量', () => {
    const anchor = 60000
    const m = new ContextWindowManager(
      makeDeps({ getTools: () => tools, getLastPromptTokens: () => anchor } as Partial<ContextWindowDeps>)
    )
    // 只有最后一条 assistant 及其之后的内容进增量
    const delta = m.estimateMessagesTokens(history.slice(1))
    expect(m.estimateCurrentPromptTokens(history)).toBe(anchor + delta)
  })

  it('无锚点（冷启动首轮）退回全量估算', () => {
    const m = new ContextWindowManager(
      makeDeps({ getTools: () => tools, getLastPromptTokens: () => undefined } as Partial<ContextWindowDeps>)
    )
    expect(m.estimateCurrentPromptTokens(history)).toBe(m.estimateTotalTokens(history))
  })

  it('锚点法不随历史增长累积估算误差：历史再长，估算只作用于增量', () => {
    const anchor = 60000
    const longHistory: AiMessage[] = [
      ...Array.from({ length: 200 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: '很长的历史内容，'.repeat(50),
      })),
      { role: 'assistant', content: '最后一条回复' },
    ] as AiMessage[]

    const m = new ContextWindowManager(
      makeDeps({ getTools: () => tools, getLastPromptTokens: () => anchor } as Partial<ContextWindowDeps>)
    )
    const result = m.estimateCurrentPromptTokens(longHistory)
    // 200 条历史全被锚点覆盖，不重复估算——结果只比锚点多出最后一条的量
    expect(result - anchor).toBeLessThan(100)
  })
})

// ==================== 不变量 3：预算不超发 ====================

describe('不变量：预算不超发', () => {
  // 32K 是国产模型常见规格，也是固定前缀占比最吃紧的场景
  it.each([32000, CONTEXT_LENGTH])('固定前缀 + 各分区预算 ≤ 上下文窗口（%i）', (contextLength) => {
    const fixedPrefix = 19223 // 实测 assistant 模式固定前缀
    const budget = (calculateBudget as (c: number, p?: number) => ReturnType<typeof calculateBudget>)(
      contextLength,
      fixedPrefix
    )

    const allocated =
      budget.knowledge +
      budget.recentTasks +
      budget.nearTasks +
      budget.historySummary +
      budget.currentConversation

    expect(fixedPrefix + allocated).toBeLessThanOrEqual(contextLength)
  })

  it('固定前缀越大，留给历史任务的越少', () => {
    const call = calculateBudget as (c: number, p?: number) => ReturnType<typeof calculateBudget>
    const lean = call(CONTEXT_LENGTH, 5000)
    const heavy = call(CONTEXT_LENGTH, 45000) // 装了一堆 MCP / 技能

    expect(heavy.recentTasks).toBeLessThan(lean.recentTasks)
  })

  it('固定前缀吃掉大半窗口时，历史预算收敛到非负', () => {
    const call = calculateBudget as (c: number, p?: number) => ReturnType<typeof calculateBudget>
    const budget = call(CONTEXT_LENGTH, 120000)

    expect(budget.recentTasks).toBeGreaterThanOrEqual(0)
    expect(budget.knowledge).toBeGreaterThanOrEqual(0)
  })
})
