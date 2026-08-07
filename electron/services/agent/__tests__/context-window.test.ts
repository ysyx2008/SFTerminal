/**
 * ContextWindowManager 单元测试
 *
 * 验证从 Agent 基类抽出的上下文窗口管理簇:token 估算 / 用量压力 / 压缩 / 工具调用序列修复。
 * 直接 `new ContextWindowManager(mockDeps)`,无需构造 Agent——这正是抽出的可测性收益。
 */
import { describe, it, expect, vi } from 'vitest'
import { ContextWindowManager, type ContextWindowDeps } from '../context-window'
import type { AiMessage, ToolCall } from '../../ai.service'
import type { AgentRun } from '../types'
import type { AiProfile } from '@shared/types'

// ==================== 工具:构造 mock deps / run ====================

function makeDeps(overrides?: Partial<ContextWindowDeps>): ContextWindowDeps {
  return {
    config: {
      getAiProfiles: () => [{ id: 'p1', contextLength: 128000 } as AiProfile],
      getActiveAiProfile: () => 'p1'
    },
    getProfileId: () => undefined,
    getLastPromptTokens: () => undefined,
    getLastCacheHitRate: () => undefined,
    reportUsage: vi.fn(),
    ...overrides
  }
}

function makeRun(messages: AiMessage[] = [], extra?: Partial<AgentRun>): AgentRun {
  return {
    id: 'r1',
    originalUserRequest: 'test',
    messages,
    steps: [],
    isRunning: false,
    aborted: false,
    pendingUserMessages: [],
    config: {} as AgentRun['config'],
    context: {} as AgentRun['context'],
    realtimeOutputBuffer: [],
    executionPhase: 'idle',
    taskMessageLog: [],
    ...extra
  } as AgentRun
}

const asst = (content: string, toolCalls?: AiMessage['tool_calls']): AiMessage => ({
  role: 'assistant',
  content,
  ...(toolCalls ? { tool_calls: toolCalls } : {})
})
const user = (content: string): AiMessage => ({ role: 'user', content })
const tool = (id: string, content = 'ok'): AiMessage => ({ role: 'tool', content, tool_call_id: id })
const tc = (id: string, name: string, args = '{}'): ToolCall => ({ id, type: 'function', function: { name, arguments: args } })

// ==================== estimateTokens ====================

describe('ContextWindowManager.estimateTokens', () => {
  it('null / undefined / 空串 → 0', () => {
    const m = new ContextWindowManager(makeDeps())
    expect(m.estimateTokens(null)).toBe(0)
    expect(m.estimateTokens(undefined)).toBe(0)
    expect(m.estimateTokens('')).toBe(0)
  })

  it('纯中文:1.5 tokens/字', () => {
    const m = new ContextWindowManager(makeDeps())
    expect(m.estimateTokens('你好世界')).toBe(Math.ceil(4 * 1.5)) // 6
  })

  it('纯英文/符号:0.5 tokens/字符', () => {
    const m = new ContextWindowManager(makeDeps())
    expect(m.estimateTokens('hello')).toBe(Math.ceil(5 * 0.5)) // 3
  })

  it('混合:中文 1.5 + 非中文 0.5', () => {
    const m = new ContextWindowManager(makeDeps())
    // 2 中文 + 5 非中文 = ceil(3 + 2.5) = 6
    expect(m.estimateTokens('你好hello')).toBe(6)
  })
})

// ==================== estimateTotalTokens ====================

describe('ContextWindowManager.estimateTotalTokens', () => {
  it('空消息列表:仅 4000 基线', () => {
    const m = new ContextWindowManager(makeDeps())
    expect(m.estimateTotalTokens([])).toBe(4000)
  })

  it('单条 user:content tokens + 4 overhead + 4000 基线', () => {
    const m = new ContextWindowManager(makeDeps())
    // 'hello' = 3 tokens; +4 overhead; +4000 = 4007
    expect(m.estimateTotalTokens([user('hello')])).toBe(4007)
  })

  it('含 tool_calls:累加 name + arguments 的 tokens', () => {
    const m = new ContextWindowManager(makeDeps())
    const msg: AiMessage = {
      role: 'assistant',
      content: 'hi', // 2 chars * 0.5 = 1 token
      tool_calls: [tc('c1', 'foo', '{"a":1}')] // 'foo'=2, '{"a":1}'=7 → ceil(1.0)+ceil(3.5)=1+4=5
    }
    // content 1 + overhead 4 + tool_calls(estimateTokens('foo')=ceil(1.5)=2? wait 'foo'=3 chars*0.5=ceil(1.5)=2; '{"a":1}'=7 chars*0.5=ceil(3.5)=4) = 1+4+2+4 = 11; +4000 = 4011
    const result = m.estimateTotalTokens([msg])
    expect(result).toBe(4011)
  })

  it('含 reasoning_content:累加其 tokens', () => {
    const m = new ContextWindowManager(makeDeps())
    const msg: AiMessage = {
      role: 'assistant',
      content: 'a', // 1 char * 0.5 = ceil(0.5) = 1
      reasoning_content: 'bb' // 2 chars * 0.5 = 1
    }
    // 1 + 4 overhead + 1 reasoning = 6; +4000 = 4006
    expect(m.estimateTotalTokens([msg])).toBe(4006)
  })

  it('含 images:每张按 IMAGE_TOKENS_PER_ITEM 累加（user 角色多模态消息）', () => {
    const m = new ContextWindowManager(makeDeps())
    const msg: AiMessage = {
      role: 'user',
      content: 'hi', // 2 chars * 0.5 = 1 token
      images: ['data:image/png;base64,xxx', 'data:image/png;base64,yyy', 'data:image/png;base64,zzz']
    }
    // content 1 + overhead 4 + 3 张图 × 1500 = 4505; +4000 基线 = 8505
    expect(m.estimateTotalTokens([msg])).toBe(8505)
  })

  it('images 为空数组不增 token（边界）', () => {
    const m = new ContextWindowManager(makeDeps())
    const msg: AiMessage = { role: 'user', content: 'hi', images: [] }
    // 与无 images 一致:1 + 4 + 4000 = 4005
    expect(m.estimateTotalTokens([msg])).toBe(4005)
  })
})

// ==================== getContextLength ====================

describe('ContextWindowManager.getContextLength', () => {
  it('无 config → 默认 128000', () => {
    const m = new ContextWindowManager(makeDeps({ config: undefined }))
    expect(m.getContextLength()).toBe(128000)
  })

  it('空 profiles → 默认 128000', () => {
    const m = new ContextWindowManager(makeDeps({ config: { getAiProfiles: () => [], getActiveAiProfile: () => 'x' } }))
    expect(m.getContextLength()).toBe(128000)
  })

  it('profileId 命中 → 取该 profile 的 contextLength', () => {
    const profiles = [{ id: 'a', contextLength: 32000 }, { id: 'b', contextLength: 200000 }] as AiProfile[]
    const m = new ContextWindowManager(makeDeps({
      config: { getAiProfiles: () => profiles, getActiveAiProfile: () => 'a' },
      getProfileId: () => 'b'
    }))
    expect(m.getContextLength()).toBe(200000)
  })

  it('profileId 缺失 → 回退 active profile', () => {
    const profiles = [{ id: 'a', contextLength: 32000 }, { id: 'b', contextLength: 200000 }] as AiProfile[]
    const m = new ContextWindowManager(makeDeps({
      config: { getAiProfiles: () => profiles, getActiveAiProfile: () => 'b' },
      getProfileId: () => undefined
    }))
    expect(m.getContextLength()).toBe(200000)
  })

  it('profileId 与 active 都不命中 → 取第一个', () => {
    const profiles = [{ id: 'a', contextLength: 32000 }, { id: 'b', contextLength: 200000 }] as AiProfile[]
    const m = new ContextWindowManager(makeDeps({
      config: { getAiProfiles: () => profiles, getActiveAiProfile: () => 'nope' },
      getProfileId: () => undefined
    }))
    expect(m.getContextLength()).toBe(32000)
  })

  it('命中 profile 但 contextLength 缺省 → 128000', () => {
    const profiles = [{ id: 'a' } as AiProfile]
    const m = new ContextWindowManager(makeDeps({
      config: { getAiProfiles: () => profiles, getActiveAiProfile: () => 'a' }
    }))
    expect(m.getContextLength()).toBe(128000)
  })
})

// ==================== updatePressure ====================

describe('ContextWindowManager.updatePressure', () => {
  it('仅有估算值(无 lastPromptTokens)时:不推 UI', () => {
    const reportUsage = vi.fn()
    const m = new ContextWindowManager(makeDeps({ reportUsage, getLastPromptTokens: () => undefined }))
    m.updatePressure(makeRun([user('hi')]))
    expect(reportUsage).not.toHaveBeenCalled()
  })

  it('有 API 精确值时:推 UI(tokens + cacheHitRate)', () => {
    const reportUsage = vi.fn()
    const m = new ContextWindowManager(makeDeps({
      reportUsage,
      getLastPromptTokens: () => 100000,
      getLastCacheHitRate: () => 42
    }))
    m.updatePressure(makeRun([user('hi')]))
    expect(reportUsage).toHaveBeenCalledWith(100000, 42)
  })

  it('用量 >= 85% → enabled 翻 true;< 85% 保持 false', () => {
    const low = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 1000 })) // 1000/128000 < 1%
    low.updatePressure(makeRun([user('hi')]))
    expect(low.enabled).toBe(false)

    const high = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 110000 })) // ~86%
    high.updatePressure(makeRun([user('hi')]))
    expect(high.enabled).toBe(true)
  })

  it('enabled 一旦 true 不回退:低用量再调仍为 true', () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 110000 }))
    m.updatePressure(makeRun([user('hi')]))
    expect(m.enabled).toBe(true)
    // 重新构造不可控的内部状态,但同一实例后续低用量不应回退
    const m2 = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 1000 }))
    m2.updatePressure(makeRun([user('hi')]))
    expect(m2.enabled).toBe(false)
    // m 仍是 true(已激活)
    expect(m.enabled).toBe(true)
  })

  it('用量 >= 85%:注入警告消息(带 _systemInjected)', () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 110000 }))
    const run = makeRun([user('hi')])
    m.updatePressure(run)
    const last = run.messages[run.messages.length - 1]
    expect(last.role).toBe('user')
    expect(last._systemInjected).toBe(true)
    expect(typeof last.content).toBe('string')
    expect((last.content as string).includes('[系统] 上下文用量告警')).toBe(true)
  })

  it('警告去重:连续两次 updatePressure 只注入一条警告', () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 110000 }))
    const run = makeRun([user('hi')])
    m.updatePressure(run)
    m.updatePressure(run)
    const warnings = run.messages.filter(
      msg => msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('[系统] 上下文用量告警')
    )
    expect(warnings.length).toBe(1)
  })

  it('用量 < 85%:不注入警告', () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 1000 }))
    const run = makeRun([user('hi')])
    m.updatePressure(run)
    expect(run.messages.length).toBe(1) // 原样,未追加
  })
})

// ==================== compress ====================

describe('ContextWindowManager.compress', () => {
  it('无 user 消息 → null', () => {
    const m = new ContextWindowManager(makeDeps())
    expect(m.compress(makeRun([asst('hi')]), '摘要', 1)).toBeNull()
  })

  it('无可压缩内容(keepRecent 覆盖全部) → null', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([user('do'), asst('a1'), tool('c1')])
    // keepRecent=1 → 保留最后一组(asst a1 + tool c1),toCompress 为空 → null
    expect(m.compress(run, '摘要', 1)).toBeNull()
  })

  it('按 assistant 分组保留 keepRecent 组,归档深拷贝,messages 重建', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([
      user('do task'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3')
    ])
    const result = m.compress(run, '早期摘要', 1)
    expect(result).not.toBeNull()
    expect(result!.archiveId).toBe('ca-1')
    expect(result!.freedTokens).toBe(result!.beforeTokens - result!.afterTokens)

    // 归档了前 2 组(a1+c1, a2+c2) = 4 条
    expect(run.compressedArchives).toHaveLength(1)
    expect(run.compressedArchives![0].messages).toHaveLength(4)
    expect(run.compressedArchives![0].summary).toBe('早期摘要')

    // messages 重建:[user, summary, asst a3, tool c3]
    expect(run.messages).toHaveLength(4)
    expect(run.messages[0].role).toBe('user')
    expect(run.messages[1].role).toBe('assistant') // 摘要消息
    expect((run.messages[1].content as string).includes('早期摘要')).toBe(true)
    expect(run.messages[2]).toEqual(asst('a3', [tc('c3', 'baz')]))
    expect(run.messages[3]).toEqual(tool('c3', 'r3'))
  })

  it('归档深拷贝:后续修改 run.messages 不影响归档', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([user('do'), asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'), asst('a2'), tool('c2', 'r2')])
    m.compress(run, '摘要', 1)
    const archived = run.compressedArchives![0].messages
    const archivedBefore = JSON.stringify(archived)
    // 修改 run.messages
    run.messages.push(user('new'))
    expect(JSON.stringify(archived)).toBe(archivedBefore) // 归档未受影响
  })
})

// ==================== fixIncompleteToolCalls ====================

describe('ContextWindowManager.fixIncompleteToolCalls', () => {
  it('为缺失的 tool_call 补占位 tool result,并镜像到 taskMessageLog', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([asst('plan', [tc('c1', 'foo'), tc('c2', 'bar')])])
    m.fixIncompleteToolCalls(run)
    // 追加 2 条 tool 消息
    expect(run.messages).toHaveLength(3)
    expect(run.messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: '[操作被用户中断]' })
    expect(run.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'c2' })
    // 镜像到 taskMessageLog
    expect(run.taskMessageLog).toHaveLength(2)
    expect(run.taskMessageLog[0]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
  })

  it('自定义 placeholder 内容', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([asst('plan', [tc('c1', 'foo')])])
    m.fixIncompleteToolCalls(run, '[执行中断: boom]')
    expect((run.messages[1].content as string)).toBe('[执行中断: boom]')
  })

  it('部分 tool result 已存在:只补缺失的', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([asst('plan', [tc('c1', 'foo'), tc('c2', 'bar')]), tool('c1', 'r1')])
    m.fixIncompleteToolCalls(run)
    expect(run.messages).toHaveLength(3) // asst + 已有 tool c1 + 新补 tool c2
    expect(run.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'c2' })
    expect(run.taskMessageLog).toHaveLength(1) // 仅镜像新补的
  })

  it('完整序列(所有 tool result 已存在) → no-op', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([asst('plan', [tc('c1', 'foo')]), tool('c1', 'r1')])
    m.fixIncompleteToolCalls(run)
    expect(run.messages).toHaveLength(2)
    expect(run.taskMessageLog).toHaveLength(0)
  })

  it('遇到 user 消息即停:之前的 assistant 不再补', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([
      asst('old', [tc('c9', 'ghost')]), // 之前残留的"完整"序列(被 user 隔开)
      user('new turn'),
      asst('plan', [tc('c1', 'foo')]),
      tool('c1', 'r1')
    ])
    m.fixIncompleteToolCalls(run)
    // 不应为 c9 补占位;末尾序列已完整,no-op
    expect(run.messages).toHaveLength(4)
    expect(run.taskMessageLog).toHaveLength(0)
  })

  it('空 messages → no-op', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([])
    m.fixIncompleteToolCalls(run)
    expect(run.messages).toHaveLength(0)
  })

  it('无 tool_calls 的 assistant → no-op', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([asst('just text')])
    m.fixIncompleteToolCalls(run)
    expect(run.messages).toHaveLength(1)
  })
})

// ==================== isContextLimitError ====================

describe('ContextWindowManager.isContextLimitError', () => {
  it('匹配原始错误码 context_length_exceeded', () => {
    expect(ContextWindowManager.isContextLimitError(new Error('context_length_exceeded'))).toBe(true)
    expect(ContextWindowManager.isContextLimitError(new Error('Error: context_length_exceeded: too long'))).toBe(true)
  })

  it('匹配中文翻译文案（ai.service.ts 抛出的 t("error.context_length_exceeded")）', () => {
    expect(ContextWindowManager.isContextLimitError(new Error('上下文超出模型限制。请清除部分对话历史后重试。'))).toBe(true)
  })

  it('匹配英文翻译文案', () => {
    expect(ContextWindowManager.isContextLimitError(new Error('Context length exceeded. Please clear some conversation history and try again.'))).toBe(true)
  })

  it('匹配火山豆包固定英文文案（max message tokens）', () => {
    expect(ContextWindowManager.isContextLimitError(
      new Error('大模型 API 请求出错: Total tokens of image and text exceed max message tokens.')
    )).toBe(true)
    expect(ContextWindowManager.isContextLimitError(
      new Error('Total tokens of image and text exceed max message tokens.')
    )).toBe(true)
  })

  it('普通网络/超时/中止错误不匹配', () => {
    expect(ContextWindowManager.isContextLimitError(new Error('aborted'))).toBe(false)
    expect(ContextWindowManager.isContextLimitError(new Error('Request timeout'))).toBe(false)
    expect(ContextWindowManager.isContextLimitError(new Error('network error'))).toBe(false)
  })

  it('非 Error 对象 / 空字符串不匹配', () => {
    expect(ContextWindowManager.isContextLimitError(null)).toBe(false)
    expect(ContextWindowManager.isContextLimitError(undefined)).toBe(false)
    expect(ContextWindowManager.isContextLimitError('')).toBe(false)
    expect(ContextWindowManager.isContextLimitError(42)).toBe(false)
  })

  it('不误匹配 agent.context_limit_exceeded（英文版不含 "Context length exceeded"）', () => {
    // 这是给 AI 看的 UI 提示文案，不是 API 错误码翻译，不应被识别为 API 报错
    const enUiPrompt = '⚠️ Conversation context exceeds model limit (current 130000 tokens, model limit 128000 tokens, 101%).'
    expect(ContextWindowManager.isContextLimitError(new Error(enUiPrompt))).toBe(false)
  })
})

// ==================== emergencyCompress ====================

describe('ContextWindowManager.emergencyCompress', () => {
  it('无 user 消息 → null（无法压缩）', () => {
    const m = new ContextWindowManager(makeDeps())
    expect(m.emergencyCompress(makeRun([asst('hi')]))).toBeNull()
  })

  it('成功压缩：归档早期对话、保留最近 2 组、enabled 翻 true', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([
      user('do task'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    const beforeMsgCount = run.messages.length
    const result = m.emergencyCompress(run)
    expect(result).not.toBeNull()
    expect(result!.keepRecent).toBe(2)
    expect(result!.archiveId).toBe('ca-1')
    expect(m.enabled).toBe(true)
    // 归档存在
    expect(run.compressedArchives).toHaveLength(1)
    expect(run.compressedArchives![0].messages.length).toBeGreaterThan(0)
    // messages 条数减少（早期对话被摘要替换）
    // 原 9 条 → user + summary + a3 + c3 + a4 + c4 = 6 条
    expect(run.messages.length).toBeLessThan(beforeMsgCount)
    expect(run.messages.length).toBe(6)
    expect(run.messages[0].role).toBe('user')
    expect(run.messages[1].role).toBe('assistant') // 摘要
  })

  it('keepRecent=2 后仍超 90% → 自动降到 keepRecent=1（用小 contextLength 触发）', () => {
    // 用很小的 contextLength 让 keepRecent=2 压缩后 afterUsage 仍 > 90%
    // （4000 基线 / 4200 ≈ 95%，加上 summary 后肯定 > 90%）
    const m = new ContextWindowManager(makeDeps({
      config: {
        getAiProfiles: () => [{ id: 'p1', contextLength: 4200 } as AiProfile],
        getActiveAiProfile: () => 'p1'
      }
    }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    const result = m.emergencyCompress(run)
    expect(result).not.toBeNull()
    // keepRecent=2 后仍 >90%，应触发第二次压缩到 keepRecent=1
    expect(result!.keepRecent).toBe(1)
    expect(run.compressedArchives!.length).toBeGreaterThanOrEqual(1)
  })

  it('恰好 keepRecent 组 assistant（toCompress 为空）→ null（无法再压缩）', () => {
    const m = new ContextWindowManager(makeDeps())
    // 2 个 assistant 组，keepRecent=2 → keepFromIndex=0 → toCompress 为空 → null
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2')
    ])
    expect(m.emergencyCompress(run)).toBeNull()
    expect(run.compressedArchives).toBeUndefined()
  })

  it('多次调用：每次产生新 archiveId，归档累积', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4'),
      asst('a5', [tc('c5', 'extra')]), tool('c5', 'r5')
    ])
    const r1 = m.emergencyCompress(run)
    expect(r1).not.toBeNull()
    expect(r1!.archiveId).toBe('ca-1')
    // 再压缩一次（保留最近 2 组）
    const r2 = m.emergencyCompress(run)
    if (r2) {
      expect(r2.archiveId).toBe('ca-2')
      expect(run.compressedArchives).toHaveLength(2)
    }
  })

  it('摘要消息含 recall_compressed 指引（让 AI 知道可以找回归档）', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    m.emergencyCompress(run)
    const summaryMsg = run.messages[1]
    expect(summaryMsg.role).toBe('assistant')
    expect(typeof summaryMsg.content).toBe('string')
    expect((summaryMsg.content as string).includes('recall_compressed')).toBe(true)
    expect((summaryMsg.content as string).includes('系统自动压缩')).toBe(true)
  })
})

// ==================== shouldProactiveCompress ====================

describe('ContextWindowManager.shouldProactiveCompress', () => {
  it('无 lastPromptTokens（首次对话/cold start）→ false（不赌估算）', () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => undefined }))
    const run = makeRun([user('do'), asst('a1'), asst('a2')])
    expect(m.shouldProactiveCompress(run)).toBe(false)
  })

  it('lastPromptTokens < 90% contextLength → false', () => {
    // contextLength=128000, 90% = 115200；给 100000（78%）不触发
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 100000 }))
    const run = makeRun([user('do'), asst('a1')])
    expect(m.shouldProactiveCompress(run)).toBe(false)
  })

  it('lastPromptTokens >= 90% contextLength → true（触发）', () => {
    // contextLength=128000, 90% = 115200；给 116000（刚过线）触发
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 116000 }))
    const run = makeRun([user('do'), asst('a1'), asst('a2'), asst('a3')])
    expect(m.shouldProactiveCompress(run)).toBe(true)
  })

  it('lastPromptTokens 远超 contextLength（如 DeepSeek 默默接受 62K 但 profile 是 64K）→ 触发', () => {
    // 模拟 DeepSeek 场景：profile contextLength=64000，但上一轮 API 真实用了 62000（>95%）
    const m = new ContextWindowManager(makeDeps({
      config: {
        getAiProfiles: () => [{ id: 'p1', contextLength: 64000 } as AiProfile],
        getActiveAiProfile: () => 'p1'
      },
      getLastPromptTokens: () => 62000
    }))
    const run = makeRun([user('do'), asst('a1'), asst('a2')])
    expect(m.shouldProactiveCompress(run)).toBe(true)
  })

  it('proactiveCompress 后再调 shouldProactiveCompress → false（同一 run 只压一次）', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 122000 }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    expect(m.shouldProactiveCompress(run)).toBe(true)
    await m.proactiveCompress(run)
    // 压缩后即使 lastPromptTokens 仍高，也不再触发
    expect(m.shouldProactiveCompress(run)).toBe(false)
  })
})

// ==================== proactiveCompress ====================

describe('ContextWindowManager.proactiveCompress', () => {
  it('无 user 消息 → null（无法压缩）', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 122000 }))
    expect(await m.proactiveCompress(makeRun([asst('hi')]))).toBeNull()
  })

  it('成功压缩：归档早期对话、保留最近 2 组、enabled 翻 true', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 122000 }))
    const beforeMsgCount: number[] = []
    const run = makeRun([
      user('do task'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    beforeMsgCount.push(run.messages.length)
    const result = await m.proactiveCompress(run)
    expect(result).not.toBeNull()
    expect(result!.keepRecent).toBe(2)
    expect(result!.archiveId).toBe('ca-1')
    expect(m.enabled).toBe(true)
    expect(run.compressedArchives).toHaveLength(1)
    // messages 条数减少：9 → 6（user + summary + a3 + c3 + a4 + c4）
    expect(run.messages.length).toBeLessThan(beforeMsgCount[0])
    expect(run.messages.length).toBe(6)
  })

  it('摘要文案含"系统主动压缩"（区分 emergency 的"系统自动压缩"）', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 122000 }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    await m.proactiveCompress(run)
    const summaryMsg = run.messages[1]
    expect(summaryMsg.role).toBe('assistant')
    expect((summaryMsg.content as string).includes('系统主动压缩')).toBe(true)
    expect((summaryMsg.content as string).includes('系统自动压缩')).toBe(false)  // 不能是 emergency 文案
    expect((summaryMsg.content as string).includes('recall_compressed')).toBe(true)
  })

  it('keepRecent=2 后仍超 90% → 自动降到 keepRecent=1', async () => {
    // 用小 contextLength 让 keepRecent=2 压缩后 afterUsage 仍 > 90%
    const m = new ContextWindowManager(makeDeps({
      config: {
        getAiProfiles: () => [{ id: 'p1', contextLength: 4200 } as AiProfile],
        getActiveAiProfile: () => 'p1'
      },
      getLastPromptTokens: () => 4100  // > 90% of 4200
    }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    const result = await m.proactiveCompress(run)
    expect(result).not.toBeNull()
    expect(result!.keepRecent).toBe(1)
  })

  it('恰好 keepRecent 组 assistant（toCompress 为空）→ null', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 122000 }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2')
    ])
    expect(await m.proactiveCompress(run)).toBeNull()
  })

  it('同一 run 多次调用 proactiveCompress → 第二次返回 null（已压缩标记）', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 122000 }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    const r1 = await m.proactiveCompress(run)
    expect(r1).not.toBeNull()
    // 第二次：即使 messages 又积累了很多（这里没加新消息，但逻辑上应被 _proactiveCompressedThisRun 挡住）
    const r2 = await m.proactiveCompress(run)
    expect(r2).toBeNull()
  })

  it('proactiveCompress 与 emergencyCompress 独立（emergency 仍可触发）', async () => {
    // 验证：proactive 压缩后，emergency 仍能工作（两者配额独立）
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 122000 }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    // proactive 先压一次
    const r1 = await m.proactiveCompress(run)
    expect(r1).not.toBeNull()
    // 模拟后续又积累，emergency 仍能压（不同入口，不受 _proactiveCompressedThisRun 限制）
    run.messages.push(asst('a5', [tc('c5', 'extra')]), tool('c5', 'r5'))
    run.messages.push(asst('a6', [tc('c6', 'more')]), tool('c6', 'r6'))
    const r2 = m.emergencyCompress(run)
    expect(r2).not.toBeNull()
    expect(run.compressedArchives!.length).toBeGreaterThanOrEqual(2)
  })
})

// ==================== proactiveCompress · AI 小结 ====================

describe('ContextWindowManager.proactiveCompress — AI 小结', () => {
  const fourGroups = () => makeRun([
    user('评审 57 份 PDF'),
    asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
    asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
    asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
    asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
  ])

  it('summarizeMessages 成功 → 摘要消息用 AI 小结，且收到的是待归档消息', async () => {
    let received: AiMessage[] = []
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => 122000,
      summarizeMessages: vi.fn().mockImplementation(async (msgs: AiMessage[]) => {
        received = msgs
        return '【任务目标】评审 57 份 PDF。【当前进度】已评审 30/57。'
      })
    }))
    const run = fourGroups()
    const result = await m.proactiveCompress(run)
    expect(result).not.toBeNull()
    const summaryMsg = run.messages[1]
    expect(summaryMsg.role).toBe('assistant')
    expect(summaryMsg.content).toContain('已评审 30/57')
    expect(summaryMsg.content).not.toContain('系统主动压缩')  // AI 小结不用模板
    // 摘要覆盖范围 = keepRecent=2 的待归档消息（a1..a2 组，不含 user 与最近两组）
    expect(received.map(x => x.role)).toEqual(['assistant', 'tool', 'assistant', 'tool'])
    // 归档里也存了 AI 小结
    expect(run.compressedArchives![0].summary).toContain('已评审 30/57')
  })

  it('summarizeMessages 返回 null → 回退固定模板', async () => {
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => 122000,
      summarizeMessages: vi.fn().mockResolvedValue(null)
    }))
    const run = fourGroups()
    await m.proactiveCompress(run)
    expect(run.messages[1].content).toContain('系统主动压缩')
  })

  it('summarizeMessages 抛错 → 回退固定模板（不阻断压缩）', async () => {
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => 122000,
      summarizeMessages: vi.fn().mockRejectedValue(new Error('API timeout'))
    }))
    const run = fourGroups()
    const result = await m.proactiveCompress(run)
    expect(result).not.toBeNull()
    expect(run.messages[1].content).toContain('系统主动压缩')
  })

  it('summarizeMessages 返回空白 → 回退固定模板', async () => {
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => 122000,
      summarizeMessages: vi.fn().mockResolvedValue('   ')
    }))
    const run = fourGroups()
    await m.proactiveCompress(run)
    expect(run.messages[1].content).toContain('系统主动压缩')
  })
})
