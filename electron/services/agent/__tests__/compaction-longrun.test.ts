/**
 * 上下文压缩的长跑集成测试。
 *
 * 单个压缩动作正确不代表长会话里没事——真正的风险是「演化」：压过一次之后结构变了，
 * 再压、再压，保留项会不会累积到把窗口占满？消息序列会不会在某次压缩后出现孤儿 tool？
 * 用户最早提的那些要求还追不追得回来？这些只有连续跑几十轮才暴露得出来。
 *
 * 这里把 Conversation（真实用量序列）与 ContextWindowManager 按生产方式接在一起，
 * 模拟一段不断产生大块工具输出、期间多次换任务的长会话，每一轮都校验不变量。
 */
import { describe, it, expect, vi } from 'vitest'
import { ContextWindowManager, type ContextWindowDeps } from '../context-window'
import { Conversation } from '../../conversation/conversation'
import type { AiMessage } from '../../ai.service'
import type { AgentRun } from '../types'
import type { AiProfile } from '@shared/types'

const CONTEXT_LENGTH = 40000

function makeRun(messages: AiMessage[]): AgentRun {
  return {
    id: 'r1',
    originalUserRequest: 'longrun',
    messages,
    steps: [],
    isRunning: false,
    aborted: false,
    pendingUserMessages: [],
    config: {} as AgentRun['config'],
    context: {} as AgentRun['context'],
    realtimeOutputBuffer: [],
    executionPhase: 'idle',
    taskMessageLog: []
  } as AgentRun
}

/**
 * 按生产接线组装：用量锚点、真实用量序列、锚点作废都落到同一个 Conversation 上，
 * 这样连"压缩后序列有没有正确作废"也一并测到了。
 */
function makeManager(conv: Conversation) {
  const deps: ContextWindowDeps = {
    config: {
      getAiProfiles: () => [{ id: 'p1', contextLength: CONTEXT_LENGTH } as AiProfile],
      getActiveAiProfile: () => 'p1'
    },
    getProfileId: () => undefined,
    getLastPromptTokens: () => conv.lastPromptTokens,
    getLastCacheHitRate: () => undefined,
    reportUsage: vi.fn(),
    invalidateTokenAnchor: () => conv.setLastPromptTokens(undefined),
    measureMessageRange: (from, to) => conv.measureMessageRange(from, to),
    summarizeMessages: vi.fn().mockResolvedValue('【交接】当前进度与关键结论。'),
    minProactiveRangeTokens: 500
  }
  return new ContextWindowManager(deps)
}

/** 消息序列必须始终能发给 API：这些违规任何一条都会让请求直接被拒 */
function assertSequenceValid(messages: AiMessage[], where: string) {
  const declared = new Set(messages.flatMap(m => (m.tool_calls ?? []).map(c => c.id)))
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'tool') {
      expect(declared.has(msg.tool_call_id!), `${where}: 孤儿 tool ${msg.tool_call_id}`).toBe(true)
    }
    if (msg.role === 'system') {
      expect(i, `${where}: system 不在最前`).toBe(0)
    }
    if (i > 0 && msg.role === 'user') {
      expect(messages[i - 1].role, `${where}: 连续两条 user`).not.toBe('user')
    }
  }
}

describe('上下文压缩 — 长会话演化', () => {
  it('连续跑 120 轮、期间换十几次任务：规模有界、序列合法、用户要求可追溯', async () => {
    const conv = Conversation.create({ agentKey: 'tab-longrun', terminalType: 'assistant' })
    const m = makeManager(conv)
    const messages: AiMessage[] = [{ role: 'system', content: 'S'.repeat(8000) }]
    const run = makeRun(messages)

    const userRequests: string[] = []
    const pushUserTask = (n: number) => {
      // 用户原话给得比较长（贴了需求说明那种），让成对保留最终撞上预算上限，
      // 把「超预算的老任务整对让位」这条路真正跑到
      const text = `任务${n}：处理第 ${n} 批数据，输出到 /tmp/out-${n}.txt。补充说明：${'需求细节。'.repeat(120)}`
      userRequests.push(text)
      run.messages.push({ role: 'user', content: text })
    }

    pushUserTask(1)
    let compressions = 0
    const sizes: number[] = []

    const TOTAL_ROUNDS = 200
    for (let round = 1; round <= TOTAL_ROUNDS; round++) {
      // 一轮工具调用，输出较大（真实场景里命令输出就是这个量级）
      run.messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: `c${round}`, type: 'function', function: { name: 'exec', arguments: '{}' } }]
      })
      run.messages.push({ role: 'tool', tool_call_id: `c${round}`, content: `输出 ${'D'.repeat(4000)}` })

      // 每 8 轮结束一件事、开启下一件
      if (round % 8 === 0) {
        run.messages.push({ role: 'assistant', content: `任务${userRequests.length}完成：结论若干` })
        if (round < TOTAL_ROUNDS) pushUserTask(userRequests.length + 1)
      }

      // 模拟 API 响应：真实 prompt_tokens 落进用量序列（生产里由 recordPromptUsage 写入）
      conv.recordPromptUsage(run.messages.length, m.estimateTotalTokens(run.messages))

      if (m.shouldProactiveCompress(run)) {
        const before = m.estimateTotalTokens(run.messages)
        const result = await m.proactiveCompress(run)
        if (result) {
          compressions++
          const after = m.estimateTotalTokens(run.messages)
          expect(after, `第 ${compressions} 次压缩后反而变大了`).toBeLessThan(before)
          m.resetForNewRun()   // 生产里下一个任务开始时清防抖
        }
      }

      assertSequenceValid(run.messages, `第 ${round} 轮`)
      sizes.push(m.estimateTotalTokens(run.messages))
    }

    // 压缩确实反复发生过，不是一次就再没触发
    expect(compressions).toBeGreaterThanOrEqual(3)

    // 规模有界：始终没有失控到窗口之外
    expect(Math.max(...sizes)).toBeLessThan(CONTEXT_LENGTH)

    // 不累积：后半程的规模不比前半程高出一个量级
    const firstCompressIdx = sizes.findIndex((s, i) => i > 0 && s < sizes[i - 1])
    const tail = sizes.slice(firstCompressIdx)
    expect(Math.max(...tail)).toBeLessThan(CONTEXT_LENGTH)

    // 用户提过的每一件事都追得回来：要么还在上下文里，要么在归档里
    const live = JSON.stringify(run.messages)
    const archived = JSON.stringify(run.compressedArchives ?? [])
    for (const req of userRequests) {
      const head = req.slice(0, 12)
      expect(live.includes(head) || archived.includes(head), `用户要求丢了：${req}`).toBe(true)
    }

    // 最近的那件事必须还在眼前（不能只躺在归档里）
    expect(live).toContain(userRequests[userRequests.length - 1].slice(0, 12))

    // 预算上限真的生效过：最早那些任务已经整对让位进了归档，不再占着上下文。
    // 没有这条，「保留项累积到把窗口占满」的老毛病就会换个形式复发。
    const evicted = userRequests.filter(req => !live.includes(req.slice(0, 12)))
    expect(evicted.length, '成对保留一直在涨，从没淘汰过老任务').toBeGreaterThan(0)
    expect(archived).toContain(evicted[0].slice(0, 12))
  })

  it('压缩后用量序列作废，不会拿旧读数算出错误的区间大小', async () => {
    const conv = Conversation.create({ agentKey: 'tab-ledger', terminalType: 'assistant' })
    const m = makeManager(conv)
    const run = makeRun([
      { role: 'system', content: 'S'.repeat(4000) },
      { role: 'user', content: '任务一' },
      { role: 'assistant', content: '完成一' },
      { role: 'user', content: '任务二' }
    ])

    for (let i = 1; i <= 6; i++) {
      run.messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'exec', arguments: '{}' } }]
      })
      run.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'D'.repeat(6000) })
      conv.recordPromptUsage(run.messages.length, m.estimateTotalTokens(run.messages))
    }

    expect(conv.measureMessageRange(6, 8)).toBeGreaterThan(0)  // 压缩前有真实读数
    expect(await m.proactiveCompress(run)).not.toBeNull()

    // 压缩改变了消息序列，旧读数与新索引对不上号，必须整体作废
    expect(conv.lastPromptTokens).toBeUndefined()
    expect(conv.measureMessageRange(6, 8)).toBeUndefined()
  })

  it('全程没有可压缩内容时不会空转，也不会破坏消息', async () => {
    const conv = Conversation.create({ agentKey: 'tab-idle', terminalType: 'assistant' })
    const m = makeManager(conv)
    const original: AiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '就问一句' },
      { role: 'assistant', content: '答一句' }
    ]
    const run = makeRun([...original])
    conv.recordPromptUsage(run.messages.length, 100)

    expect(m.shouldProactiveCompress(run)).toBe(false)
    expect(run.messages).toEqual(original)
  })
})
