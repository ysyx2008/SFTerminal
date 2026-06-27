/**
 * Conversation 聚合根单测。
 *
 * 这些断言是阶段 0 特征网（agent 行为）在领域模型层的镜像——刻意用同款不变量，
 * 确保「搬进 Conversation 的逻辑」与「Agent 现状行为」字节对齐：
 *   - fromRecord 用 messages 切分重建 taskMemory（_systemInjected 不构成边界）
 *   - toRecord/fromRecord round-trip 稳定（messages/steps/身份/形态/token）
 *   - commitRun：reasoning_content 空串保留进 cache 前缀；transcript/token 累积
 *   - cache 前缀复用判定（无前缀/wakeup/超 70% 跳过）
 *   - reset 清空 transcript + 工作记忆
 *
 * 纯单测，不碰磁盘/electron（Conversation 是纯领域对象）。
 */
import { describe, it, expect } from 'vitest'
import { Conversation } from '../conversation'
import type { AgentRecord, AgentStep } from '@shared/types'
import type { AiMessage } from '../../ai.service'

const userStep = (content: string): AgentStep =>
  ({ id: `u_${content}`, type: 'user_task', content, timestamp: Date.now() } as AgentStep)
const finalStep = (content: string): AgentStep =>
  ({ id: `f_${content}`, type: 'final_result', content, timestamp: Date.now() } as AgentStep)

describe('Conversation 聚合根（领域模型）', () => {
  it('create：kind 默认由 agentKey 推断，形态/身份就位', () => {
    const task = Conversation.create({ agentKey: 'tab-1', terminalType: 'local' })
    expect(task.kind).toBe('task')
    expect(task.terminalType).toBe('local')
    expect(task.agentKey).toBe('tab-1')

    const companion = Conversation.create({ agentKey: '__companion__', terminalType: 'assistant' })
    expect(companion.kind).toBe('companion')

    const watch = Conversation.create({ agentKey: '__watch__', terminalType: 'assistant' })
    expect(watch.kind).toBe('watch')

    // 显式 kind 覆盖推断
    const forced = Conversation.create({ agentKey: 'tab-x', terminalType: 'ssh', kind: 'companion' })
    expect(forced.kind).toBe('companion')
  })

  it('fromRecord：用 messages 切分重建 taskMemory，_systemInjected 不构成任务边界', () => {
    const messages: AiMessage[] = [
      { role: 'user', content: '真实任务一' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '系统注入占位', _systemInjected: true } as AiMessage,
      { role: 'assistant', content: '答一续' },
      { role: 'user', content: '真实任务二' },
      { role: 'assistant', content: '答二' }
    ]
    const record: AgentRecord = {
      id: 'sess_x', timestamp: Date.now(), terminalId: '', agentKey: 'tab-1',
      terminalType: 'assistant', userTask: '真实任务一', steps: [], messages,
      duration: 0, status: 'completed'
    } as AgentRecord

    const conv = Conversation.fromRecord(record)
    // 只在两条真实 user 处断开 → 2 个任务（注入那条并入前一任务）
    expect(conv.taskMemory.getTaskCount()).toBe(2)
    // transcript 全量恢复
    expect(conv.messages.length).toBe(6)
    // 身份/形态从记录恢复
    expect(conv.id).toBe('sess_x')
    expect(conv.kind).toBe('task')
  })

  it('fromRecord：缺 kind 的老记录按 agentKey 推断', () => {
    const record: AgentRecord = {
      id: 'sess_legacy', timestamp: Date.now(), terminalId: '', agentKey: '__companion__',
      terminalType: 'assistant', userTask: 'hi', steps: [],
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      duration: 0, status: 'completed'
    } as AgentRecord
    expect(Conversation.fromRecord(record).kind).toBe('companion')
  })

  it('fromRecord：刻意不恢复 token 账（与现状 restoreFromSessionRecord 对齐，重开从零累积）', () => {
    const record: AgentRecord = {
      id: 'sess_tok', timestamp: Date.now(), terminalId: '', agentKey: 'tab-1',
      terminalType: 'assistant', userTask: 'q', steps: [],
      messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
      duration: 0, status: 'completed',
      tokenUsage: { prompt_tokens: 99, completion_tokens: 11, total_tokens: 110 }
    } as AgentRecord
    // 历史记录带 tokenUsage，但恢复后会话 token 账保持空白（保留当前行为）
    expect(Conversation.fromRecord(record).tokenUsage).toBeUndefined()
  })

  it('toRecord：空会话（无 user_task）返回 null', () => {
    const conv = Conversation.create({ agentKey: 'tab-1', terminalType: 'local' })
    expect(conv.toRecord()).toBeNull()
  })

  it('toRecord / fromRecord round-trip：messages/steps/身份/形态/token 稳定', () => {
    const conv = Conversation.create(
      { agentKey: 'tab-rt', terminalType: 'ssh' },
      { id: 'sess_rt', createdAt: 1000, sshHost: 'h1' }
    )
    conv.commitRun({
      runId: 'run1',
      userRequest: '问题一',
      steps: [userStep('问题一'), finalStep('回答一')],
      taskMessageLog: [{ role: 'user', content: '问题一' }],
      runMessages: [{ role: 'user', content: '问题一' }],
      taskStatus: 'success',
      result: '回答一',
      reasoningContent: '',
      tokenUsage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })

    const record = conv.toRecord({ terminalId: 'pty-1' })!
    expect(record).toBeTruthy()
    expect(record.id).toBe('sess_rt')
    expect(record.kind).toBe('task')
    expect(record.terminalType).toBe('ssh')
    expect(record.sshHost).toBe('h1')
    expect(record.userTask).toBe('问题一')
    expect(record.finalResult).toBe('回答一')
    expect(record.tokenUsage?.total_tokens).toBe(15)
    // transcript：user + 最终 assistant 回复
    expect(record.messages!.length).toBe(2)

    // 反序列化后再序列化：核心字段保持
    const conv2 = Conversation.fromRecord(record)
    const record2 = conv2.toRecord({ terminalId: 'pty-1' })!
    expect(record2.id).toBe('sess_rt')
    expect(record2.kind).toBe('task')
    expect(record2.terminalType).toBe('ssh')
    expect(record2.userTask).toBe('问题一')
    expect(record2.messages!.length).toBe(2)
    expect(conv2.taskMemory.getTaskCount()).toBe(1)
  })

  it('commitRun：reasoning_content 空串保留进 cache 前缀（带 tool_calls 的 assistant 不丢字段）', () => {
    const conv = Conversation.create({ agentKey: 'tab-r', terminalType: 'assistant' })
    const runMessages: AiMessage[] = [
      { role: 'user', content: '用工具' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fake', arguments: '{}' } }]
      } as AiMessage,
      { role: 'tool', content: 'Unknown tool', tool_call_id: 'c1' } as AiMessage
    ]
    conv.commitRun({
      runId: 'run-r',
      userRequest: '用工具',
      steps: [userStep('用工具'), finalStep('完成')],
      taskMessageLog: [...runMessages],
      runMessages,
      taskStatus: 'success',
      result: '完成',
      reasoningContent: ''
    })

    const prefix = conv.getCachePrefix()!
    expect(prefix).toBeTruthy()
    // 带 tool_calls 的那条 assistant 仍带 reasoning_content（=== '' 保留，非 undefined）
    const assistantWithTools = prefix.find(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0)!
    expect(assistantWithTools).toBeDefined()
    expect(assistantWithTools.reasoning_content).not.toBeUndefined()
    expect(assistantWithTools.reasoning_content).toBe('')
    // 末尾补了最终纯文本回复
    expect(prefix[prefix.length - 1]).toMatchObject({ role: 'assistant', content: '完成' })
  })

  it('cache 前缀复用判定：无前缀/wakeup/超 70% 跳过', () => {
    const estimate = (msgs: AiMessage[]) => msgs.length * 100
    const conv = Conversation.create({ agentKey: 'tab-c', terminalType: 'assistant' })

    // 无前缀 → false
    expect(conv.shouldReuseCachePrefix(10000, { estimateTokens: estimate })).toBe(false)

    conv.commitRun({
      runId: 'r1', userRequest: 'q', steps: [userStep('q'), finalStep('a')],
      taskMessageLog: [{ role: 'user', content: 'q' }], runMessages: [{ role: 'user', content: 'q' }],
      taskStatus: 'success', result: 'a'
    })

    // 有前缀且远小于 70% → true
    expect(conv.shouldReuseCachePrefix(10000, { estimateTokens: estimate })).toBe(true)
    // wakeup → false（内心独白不复用对话前缀）
    expect(conv.shouldReuseCachePrefix(10000, { wakeup: true, estimateTokens: estimate })).toBe(false)
    // 前缀超 70% → false（前缀 2 条 * 100 = 200，上下文 200 → 200 < 140 为假）
    expect(conv.shouldReuseCachePrefix(200, { estimateTokens: estimate })).toBe(false)
  })

  it('reset：清空 transcript / 工作记忆 / cache / token', () => {
    const conv = Conversation.create({ agentKey: 'tab-z', terminalType: 'local' })
    conv.commitRun({
      runId: 'r1', userRequest: 'q', steps: [userStep('q'), finalStep('a')],
      taskMessageLog: [{ role: 'user', content: 'q' }], runMessages: [{ role: 'user', content: 'q' }],
      taskStatus: 'success', result: 'a', tokenUsage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    })
    expect(conv.taskMemory.getTaskCount()).toBe(1)
    expect(conv.messages.length).toBeGreaterThan(0)

    conv.reset()
    expect(conv.taskMemory.getTaskCount()).toBe(0)
    expect(conv.messages.length).toBe(0)
    expect(conv.steps.length).toBe(0)
    expect(conv.getCachePrefix()).toBeUndefined()
    expect(conv.tokenUsage).toBeUndefined()
  })

  it('rebind：会话漫游只换 agentKey，身份/形态不变', () => {
    const conv = Conversation.create({ agentKey: 'tab-A', terminalType: 'ssh' }, { id: 'sess_roam', sshHost: 'h1' })
    conv.rebind('tab-B')
    expect(conv.agentKey).toBe('tab-B')
    expect(conv.id).toBe('sess_roam')
    expect(conv.terminalType).toBe('ssh')
    expect(conv.sshHost).toBe('h1')
  })
})
