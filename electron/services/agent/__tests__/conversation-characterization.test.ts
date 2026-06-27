/**
 * 特征测试网（characterization）：会话/记忆现有行为的红线
 *
 * 目的：在「会话领域模型 OOP 重构」（docs/conversation-refactor-design.md）动刀之前，
 * 把今天散在 Agent 上的 `_session*` + buildContext/finalize/restore 机器的**外部可观测行为**
 * 钉成测试。重构（把这套机器搬进 Conversation 聚合根）必须保持这些断言全绿——
 * 它们是「改一处崩一片」的防回归网，而不是对内部实现的断言。
 *
 * 覆盖的不变量：
 *   ① 会话连续 / prompt cache 前缀复用：同一 session 第二次 run 复用上一轮完整 messages 作前缀
 *   ② 内心独白隔离：wakeup（Watch）run 不把上一轮原始对话作为前缀复用
 *   ③ 会话漫游：新 Agent 实例带 context.sessionId 续写既有会话（同 id、恢复工作记忆、不裂记录）
 *   ④ 清空对话（reset）：清空工作记忆并开全新会话
 *   ⑤ watch 历史隔离：__watch__ 记录进独立 watch 树，不污染主 agent 索引
 *   ⑥ reasoning_content 回传：带 tool_calls 的 assistant 消息，下一轮请求仍携带 reasoning_content
 *      字段（空串也保留 → !== undefined）。DeepSeek V3.2+ 思考模式的硬约束，commitRun/finalizeRun
 *      搬迁时最易丢的字段语义（agent.ts:2300）。
 *   ⑦ 任务切分边界：splitMessagesIntoTasks 用 _systemInjected 区分「系统注入」与「真实用户边界」，
 *      注入消息并入当前任务、不另起；且该标记必须经磁盘序列化存活（agent.ts:863）。
 *   ⑧ 两种 fork 中的「任务分支完整拷贝到 fork 点」：buildForkRecord 无 untilTaskCount=全拷贝、
 *      有则截断到第 N 个任务，源记录不被破坏（文档 §2.5）。createTaskFrom（跨 kind 种子起头）是
 *      全新操作、现无可观测行为可钉，留待其实现阶段 TDD（种子策略按 §2.5 延后）。
 *
 * 联络（companion）跨重启回种、reset 抑制回种由 companion-restore.integration.test.ts 覆盖，
 * 此处不重复。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

// 每次 chatWithToolsStream 调用时传入的 messages 快照（深拷贝），用于断言上下文如何拼装
let messagesByCall: any[][] = []

// 只 mock electron（userData → 临时目录），不 mock fs，让 HistoryService 真实写盘
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

// 打断 agent.ts → tools/misc → im.service → agent/index → sailfish → agent.ts 循环依赖
vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

import { Agent } from '../agent'
import { HistoryService } from '../../history.service'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext, AgentServices } from '../types'

class TestAgent extends Agent {
  getAvailableTools(): ToolDefinition[] {
    return []
  }
  protected buildSystemPrompt(): string {
    return 'test system prompt'
  }
  protected getAgentId(): string {
    return 'test-agent'
  }
  public exposeTaskMemory() {
    return this.taskMemory
  }
  /** 暴露 restore 路径的私有切分函数，供 ⑦ 直接钉「真实用户边界 vs 系统注入」不变量 */
  public exposeSplitTasks(messages: any[]) {
    return (this as any).splitMessagesIntoTasks(messages)
  }
}

/** 单次 LLM 响应（按调用序号返回）；省略字段沿用默认（内容「好的」、无 tool_calls） */
type LlmResponse = { content?: string; reasoning_content?: string; tool_calls?: any[] }
type Responder = (callIndex: number) => LlmResponse
const defaultResponder: Responder = () => ({ content: '好的' })

function makeServices(history: HistoryService, responder: Responder = defaultResponder): AgentServices {
  let callIndex = 0
  return {
    aiService: {
      chatWithToolsStream: vi.fn(
        (messages: any[], _t: unknown, onChunk: (s: string) => void, _otc: unknown, onDone: (r: unknown) => void) => {
          messagesByCall.push(JSON.parse(JSON.stringify(messages)))
          const r = responder(callIndex++)
          const content = r.content ?? '好的'
          if (content) onChunk(content)
          // reasoning_content 显式回传（含 undefined）：agent.ts 用 !== undefined 决定是否保留空串
          onDone({ content, reasoning_content: r.reasoning_content, tool_calls: r.tool_calls })
          return Promise.resolve()
        }
      ),
      abort: vi.fn()
    } as any,
    ptyService: { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any,
    configService: {
      get: vi.fn().mockReturnValue(undefined),
      getAgentMbti: vi.fn().mockReturnValue(null),
      getAiRules: vi.fn().mockReturnValue(''),
      getAgentPersonalityText: vi.fn().mockReturnValue(''),
      getAgentName: vi.fn().mockReturnValue(''),
      getLanguage: vi.fn().mockReturnValue('zh-CN'),
      getAiProfiles: vi.fn().mockReturnValue([{ id: 'test', contextLength: 128000 }]),
      getActiveAiProfile: vi.fn().mockReturnValue('test'),
      getAgentOnboardingCompleted: vi.fn().mockReturnValue(true),
      hasVisionCapability: vi.fn().mockReturnValue(true)
    } as any,
    historyService: history as any
  }
}

function ctx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    terminalOutput: [],
    systemInfo: { os: 'darwin', shell: '/bin/zsh' },
    terminalType: 'assistant',
    ...overrides
  } as AgentContext
}

/** 普通 tab Agent（非持久命名）——测试任务/漫游的正常恢复路径 */
function newTabAgent(history: HistoryService, agentKey: string, responder?: Responder): TestAgent {
  const agent = new TestAgent(makeServices(history, responder))
  agent.setAgentId(agentKey)
  return agent
}

/** 持久命名 Agent（companion/watch） */
function newNamedAgent(history: HistoryService, agentKey: string, responder?: Responder): TestAgent {
  const agent = new TestAgent(makeServices(history, responder))
  agent.setAgentId(agentKey)
  agent.markAsPersistentNamed()
  return agent
}

const rolesOf = (msgs: any[]): string[] => msgs.map(m => m.role)
const textOf = (m: any): string => {
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
  }
  return ''
}
const hasAssistantTurn = (msgs: any[]): boolean => msgs.some(m => m.role === 'assistant')

describe('会话/记忆特征测试网（characterization · 真实 HistoryService 磁盘往返）', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-conv-char-'))
    messagesByCall = []
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('① 会话连续 / cache 前缀复用：同 session 第二轮复用上一轮完整 messages 作前缀', async () => {
    const history = new HistoryService()
    const agent = newTabAgent(history, 'tab-cache')

    await agent.run('第一条消息', ctx({ sessionId: 'sess_cache_1', sessionStartTime: Date.now() - 1000 }))
    const call1 = messagesByCall[0]

    await agent.run('第二条消息', ctx()) // 同实例同 session（_sessionId 已持久）
    const call2 = messagesByCall[messagesByCall.length - 1]

    // 首轮请求里没有上一轮 assistant；第二轮把上一轮 assistant 回复作为原始消息带入（= 连续 / cache 复用）
    expect(hasAssistantTurn(call1)).toBe(false)
    expect(hasAssistantTurn(call2)).toBe(true)

    // 上下文累积：第二轮更长，且前 call1.length 条角色序列与首轮一致（前缀稳定 → provider 前缀缓存可命中）
    expect(call2.length).toBeGreaterThan(call1.length)
    expect(rolesOf(call2).slice(0, call1.length)).toEqual(rolesOf(call1))

    // 上一轮 assistant 的内容确实被原样携带
    expect(call2.some(m => m.role === 'assistant' && textOf(m).includes('好的'))).toBe(true)
  })

  it('② 内心独白隔离：wakeup（Watch）run 不复用上一轮原始对话作前缀', async () => {
    const history = new HistoryService()
    const agent = newNamedAgent(history, '__watch__')

    await agent.run('普通一轮', ctx({ sessionId: 'sess_wk_1', sessionStartTime: Date.now() - 1000 }))
    const callsBefore = messagesByCall.length

    await agent.run('唤醒巡检', ctx({ wakeup: true }))
    const wkCall = messagesByCall[messagesByCall.length - 1]

    expect(messagesByCall.length).toBeGreaterThan(callsBefore)
    // wakeup 走 cold start，不把上一轮 assistant 原始消息作为前缀复用（内心独白与对话隔离）
    expect(hasAssistantTurn(wkCall)).toBe(false)
  })

  it('③ 会话漫游（同形态）：新 Agent 带 context.sessionId 续写既有会话（同 id、恢复工作记忆、不裂记录）', async () => {
    const history = new HistoryService()

    // 会话最初在 ssh 形态（host h1）、由 tab-A 跑
    const a1 = newTabAgent(history, 'tab-A')
    await a1.run('在 SSH 上排查 nginx', ctx({
      sessionId: 'sess_roam',
      sessionStartTime: Date.now() - 60000,
      terminalType: 'ssh',
      sshHost: 'h1'
    }))
    expect(new HistoryService().getAgentRecordById('sess_roam')).toBeTruthy()

    // 用户从「最近对话」在另一个连同一台 host 的 SSH tab-B 接着聊
    //（漫游：同 sessionId、不同 agentKey、形态 terminalType/sshHost 不变）
    const a2 = newTabAgent(new HistoryService(), 'tab-B')
    await a2.run('继续看看日志', ctx({ sessionId: 'sess_roam', terminalType: 'ssh', sshHost: 'h1' }))

    // 同一条会话续写
    expect(a2.getSessionId()).toBe('sess_roam')
    // 恢复了既有工作记忆（之前那轮 + 当前这轮）
    expect(a2.exposeTaskMemory().getTaskCount()).toBeGreaterThanOrEqual(1)

    // 没裂出第二条：sess_roam 仍只有一条记录
    const recs = new HistoryService().getRecentAgentRecords(50).filter(r => r.id === 'sess_roam')
    expect(recs.length).toBe(1)
  })

  it('④ 清空对话（reset）：清空工作记忆并开全新会话', async () => {
    const history = new HistoryService()
    const agent = newTabAgent(history, 'tab-reset')

    await agent.run('第一段对话', ctx({ sessionId: 'sess_reset_1', sessionStartTime: Date.now() - 1000 }))
    expect(agent.getSessionId()).toBe('sess_reset_1')

    agent.resetSession()
    await agent.run('清空后全新开始', ctx()) // 无 sessionId

    // 全新会话，不再是旧 id
    expect(agent.getSessionId()).not.toBe('sess_reset_1')
    expect(agent.getSessionId()).toMatch(/^session_\d+/)
    // 工作记忆被清空，只剩 reset 之后这一条任务
    expect(agent.exposeTaskMemory().getTaskCount()).toBe(1)
  })

  it('⑤ watch 历史隔离：__watch__ 记录进独立 watch 树，不污染主 agent 索引', async () => {
    const history = new HistoryService()

    const watch = newNamedAgent(history, '__watch__')
    await watch.run('心跳巡检任务', ctx({ wakeup: true }))

    // 进独立 watch 树
    const watchRecs = new HistoryService().getRecentWatchRecords(20)
    expect(watchRecs.length).toBeGreaterThanOrEqual(1)
    expect(watchRecs.every(r => r.agentKey === '__watch__')).toBe(true)

    // 不进主 agent 索引（不污染任务/联络列表）
    const mainRecs = new HistoryService().getRecentAgentRecords(20)
    expect(mainRecs.some(r => r.agentKey === '__watch__')).toBe(false)
  })

  it('⑥ reasoning_content 回传：带 tool_calls 的 assistant 消息，下一轮请求仍带 reasoning_content（空串保留）', async () => {
    const history = new HistoryService()
    // 第 1 轮：返回带 tool_calls 的 assistant，且 reasoning_content 为「空串」（DeepSeek 思考模式常见）
    // 第 2 轮：无 tool_calls，结束 ReAct 循环
    const agent = newTabAgent(history, 'tab-reasoning', (i) =>
      i === 0
        ? {
            content: '',
            reasoning_content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'fake_tool', arguments: '{}' } }
            ]
          }
        : { content: '完成' }
    )

    await agent.run('用一下工具', ctx({ sessionId: 'sess_reason', sessionStartTime: Date.now() - 1000 }))

    // 至少发生了两轮 LLM 调用（工具循环：调用 → 执行未知工具拿到错误 → 再调用收尾）
    expect(messagesByCall.length).toBeGreaterThanOrEqual(2)

    // 第二轮发给 LLM 的消息里，那条带 tool_calls 的 assistant 必须仍带 reasoning_content 字段
    const secondCall = messagesByCall[messagesByCall.length - 1]
    const assistantWithToolCalls = secondCall.find(
      (m: any) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0
    )
    expect(assistantWithToolCalls).toBeDefined()
    // 关键红线：字段存在（!== undefined）且空串被原样保留（不能被 `|| undefined` 吞掉）
    expect(assistantWithToolCalls.reasoning_content).not.toBeUndefined()
    expect(assistantWithToolCalls.reasoning_content).toBe('')
  })

  it('⑦ 任务切分边界：_systemInjected 的 user 消息不构成任务边界，且该标记经磁盘往返存活', async () => {
    const history = new HistoryService()
    const agent = newTabAgent(history, 'tab-split')

    // 两个真实 user 边界，中间夹一条 _systemInjected 的 user 消息（如「工具读图占位」「上下文压力警告」）
    const messages: any[] = [
      { role: 'user', content: '真实任务一' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '系统注入占位', _systemInjected: true },
      { role: 'assistant', content: '答一续' },
      { role: 'user', content: '真实任务二' },
      { role: 'assistant', content: '答二' }
    ]
    history.saveAgentRecord({
      id: 'sess_split',
      timestamp: Date.now(),
      terminalId: '',
      terminalType: 'assistant',
      agentKey: 'tab-split',
      userTask: '真实任务一',
      steps: [],
      messages,
      duration: 0,
      status: 'completed'
    } as any)

    // 真实磁盘往返：重新读出记录，验证 _systemInjected 字段经序列化未被吞
    const loaded = new HistoryService().getAgentRecordById('sess_split')!
    expect(loaded).toBeTruthy()
    expect((loaded.messages as any[]).some(m => m._systemInjected)).toBe(true)

    // 切分：只在两条真实 user 处断开 → 2 个任务；_systemInjected 那条并入前一任务、不另起
    const tasks = agent.exposeSplitTasks(loaded.messages as any[])
    expect(tasks.length).toBe(2)
    // 第一个任务含「真实任务一 / 答一 / 系统注入占位 / 答一续」共 4 条
    expect(tasks[0].messages.length).toBe(4)
    expect(tasks[0].messages.some((m: any) => m._systemInjected)).toBe(true)
    expect(tasks[1].messages.length).toBe(2)
  })

  it('⑧ 任务分支 fork：无 untilTaskCount=完整拷贝 / 有则截断到 fork 点，源记录不被破坏（真实磁盘往返）', () => {
    const history = new HistoryService()

    const messages: any[] = [
      { role: 'user', content: '任务一' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '任务二' },
      { role: 'assistant', content: '答二' }
    ]
    // buildForkRecord 要求 steps 含 user_task（否则返回 null）；按 user_task 切分对应 untilTaskCount 语义
    const steps: any[] = [
      { id: 's1', type: 'user_task', content: '任务一', timestamp: 1 },
      { id: 's2', type: 'final_result', content: '答一', timestamp: 2 },
      { id: 's3', type: 'user_task', content: '任务二', timestamp: 3 },
      { id: 's4', type: 'final_result', content: '答二', timestamp: 4 }
    ]
    history.saveAgentRecord({
      id: 'sess_fork_src',
      timestamp: Date.now(),
      terminalId: '',
      terminalType: 'assistant',
      agentKey: 'tab-fork',
      userTask: '任务一',
      steps,
      messages,
      duration: 0,
      status: 'completed'
    } as any)

    const src = new HistoryService().getAgentRecordById('sess_fork_src')!
    expect(src).toBeTruthy()

    // (a) 完整拷贝：不传 untilTaskCount → 新记录 messages 与源逐字相同（任务分支语义）
    const full = Agent.buildForkRecord(
      { messages: src.messages as any[], steps: src.steps as any[], terminalType: src.terminalType },
      'sess_fork_full'
    )!
    expect(full).toBeTruthy()
    expect(full.id).toBe('sess_fork_full')
    expect(full.messages!.length).toBe(messages.length)
    expect(full.messages).toEqual(messages)

    // (b) 截断到 fork 点：untilTaskCount=1 → 只拷贝第一个任务的 messages
    const partial = Agent.buildForkRecord(
      { messages: src.messages as any[], steps: src.steps as any[], terminalType: src.terminalType },
      'sess_fork_partial',
      { untilTaskCount: 1 }
    )!
    expect(partial).toBeTruthy()
    expect(partial.messages!.length).toBe(2)
    expect(partial.messages).toEqual(messages.slice(0, 2))

    // 源记录不受影响（fork 不破坏原线）
    const srcAfter = new HistoryService().getAgentRecordById('sess_fork_src')!
    expect(srcAfter.messages!.length).toBe(messages.length)
  })
})
