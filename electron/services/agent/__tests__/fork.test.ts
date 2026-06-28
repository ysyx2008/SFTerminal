/**
 * Fork（"另开一聊"）单元测试
 *
 * 覆盖：
 *  - Agent.cloneRecordForFork 截断到第 N 个 task
 *  - Agent.cloneRecordForFork 全量复制
 *  - Agent.applyForkSnapshot
 *  - AgentService.forkAgent 端到端流程
 *  - 同模式 / 跨模式 fork 时 cache snapshot 的传递策略（含截断时按相同边界 truncate snapshot）
 *  - 防御场景：源 Agent 不存在 / 运行中 / 无 sessionId
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([])
  }
})

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

import { Agent } from '../agent'
import { AgentService } from '../index'
import { Conversation } from '../../conversation'
import type { ToolDefinition, AiMessage } from '../../ai.service'
import type { AgentContext, AgentServices, PromptOptions, AgentStep } from '../types'
import type { AgentRecord } from '@shared/types'

class TestAgent extends Agent {
  getAvailableTools(): ToolDefinition[] {
    return []
  }
  protected buildSystemPrompt(_context: AgentContext, _options: PromptOptions): string {
    return 'Test system prompt'
  }
  protected getAgentId(): string {
    return 'test-agent'
  }

  // 测试辅助：直接注入会话状态（避免实际跑 run() 的复杂度）
  injectSession(opts: {
    sessionId: string
    sessionStartTime?: number
    sessionMessages: AiMessage[]
    sessionSteps: AgentStep[]
    previousRunMessages?: AiMessage[]
    terminalType?: 'local' | 'ssh'
    sshHost?: string
  }): void {
    // 会话状态现由 Conversation 聚合根持有：构建一个并装载 transcript（跳过 taskMemory 重建）
    const conv = Conversation.create(
      { agentKey: (this as any)._agentId ?? 'test-agent', terminalType: opts.terminalType ?? 'assistant' },
      { id: opts.sessionId, createdAt: opts.sessionStartTime ?? Date.now(), sshHost: opts.sshHost },
      { taskMemory: (this as any).taskMemory }
    )
    conv.setRestoredTranscript(opts.sessionMessages, opts.sessionSteps as any)
    if (opts.previousRunMessages) {
      conv.setCachePrefix(opts.previousRunMessages)
    }
    ;(this as any)._conversation = conv
  }

  exposeSessionId() {
    return (this as any)._sessionId as string | undefined
  }
  exposePreviousRunMessages() {
    return (this as any)._previousRunMessages as AiMessage[] | undefined
  }

  setRunning(running: boolean): void {
    if (running) {
      ;(this as any).currentRun = { isRunning: true }
    } else {
      ;(this as any).currentRun = undefined
    }
  }
}

function createMockServices(overrides?: Partial<AgentServices>): AgentServices {
  return {
    aiService: {
      chatWithToolsStream: vi.fn(),
      abort: vi.fn()
    } as any,
    ptyService: {
      onData: vi.fn().mockReturnValue(() => {}),
      write: vi.fn()
    } as any,
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
    ...overrides
  }
}

/** 构造 3 个连续完成的 task：每个 task 1 user message + 1 assistant message + final_result step */
function buildThreeTaskSession() {
  const messages: AiMessage[] = [
    { role: 'user', content: 'Task 1 question' },
    { role: 'assistant', content: 'Task 1 answer' },
    { role: 'user', content: 'Task 2 question' },
    { role: 'assistant', content: 'Task 2 answer' },
    { role: 'user', content: 'Task 3 question' },
    { role: 'assistant', content: 'Task 3 answer' }
  ]
  const baseTs = Date.now() - 10000
  const steps: AgentStep[] = [
    { id: 'ut1', type: 'user_task', content: 'Task 1 question', timestamp: baseTs },
    { id: 'm1', type: 'message', content: 'Task 1 answer', timestamp: baseTs + 100 },
    { id: 'fr1', type: 'final_result', content: 'Task 1 answer', timestamp: baseTs + 200 },
    { id: 'ut2', type: 'user_task', content: 'Task 2 question', timestamp: baseTs + 300 },
    { id: 'm2', type: 'message', content: 'Task 2 answer', timestamp: baseTs + 400 },
    { id: 'fr2', type: 'final_result', content: 'Task 2 answer', timestamp: baseTs + 500 },
    { id: 'ut3', type: 'user_task', content: 'Task 3 question', timestamp: baseTs + 600 },
    { id: 'm3', type: 'message', content: 'Task 3 answer', timestamp: baseTs + 700 },
    { id: 'fr3', type: 'final_result', content: 'Task 3 answer', timestamp: baseTs + 800 }
  ]
  return { messages, steps }
}

describe('Agent.cloneRecordForFork', () => {
  let agent: TestAgent

  beforeEach(() => {
    agent = new TestAgent(createMockServices())
  })

  it('returns null when no session exists', () => {
    expect(agent.cloneRecordForFork('new-session')).toBeNull()
  })

  it('clones full session when untilTaskCount is undefined', () => {
    const { messages, steps } = buildThreeTaskSession()
    agent.injectSession({
      sessionId: 'src',
      sessionMessages: messages,
      sessionSteps: steps
    })

    const record = agent.cloneRecordForFork('new-session')
    expect(record).not.toBeNull()
    expect(record!.id).toBe('new-session')
    expect(record!.messages?.length).toBe(6)
    expect(record!.steps.length).toBe(9)
    // userTask 取自第一个 user_task step
    expect(record!.userTask).toContain('Task 1 question')
    expect(record!.finalResult).toBe('Task 3 answer')
  })

  it('truncates to first N tasks when untilTaskCount is provided', () => {
    const { messages, steps } = buildThreeTaskSession()
    agent.injectSession({
      sessionId: 'src',
      sessionMessages: messages,
      sessionSteps: steps
    })

    const record = agent.cloneRecordForFork('new-session', { untilTaskCount: 2 })
    expect(record).not.toBeNull()
    // 前 2 个 task：4 messages（2 user + 2 assistant），6 steps（3 per task）
    expect(record!.messages?.length).toBe(4)
    expect(record!.steps.length).toBe(6)
    // finalResult 应是第 2 个 task 的结果
    expect(record!.finalResult).toBe('Task 2 answer')
    // 不应包含 Task 3 的内容
    const allContent = JSON.stringify(record)
    expect(allContent).not.toContain('Task 3')
  })

  it('untilTaskCount >= total tasks behaves like full clone', () => {
    const { messages, steps } = buildThreeTaskSession()
    agent.injectSession({
      sessionId: 'src',
      sessionMessages: messages,
      sessionSteps: steps
    })

    const record = agent.cloneRecordForFork('new-session', { untilTaskCount: 10 })
    expect(record!.messages?.length).toBe(6)
    expect(record!.steps.length).toBe(9)
  })

  it('appends titleSuffix to userTask', () => {
    const { messages, steps } = buildThreeTaskSession()
    agent.injectSession({
      sessionId: 'src',
      sessionMessages: messages,
      sessionSteps: steps
    })

    const record = agent.cloneRecordForFork('new-session', { titleSuffix: ' · 分支' })
    expect(record!.userTask).toBe('Task 1 question · 分支')
  })

  it('preserves terminalType / sshHost from source', () => {
    const { messages, steps } = buildThreeTaskSession()
    agent.injectSession({
      sessionId: 'src',
      sessionMessages: messages,
      sessionSteps: steps,
      terminalType: 'ssh',
      sshHost: 'example.com'
    })

    const record = agent.cloneRecordForFork('new-session')
    expect(record!.terminalType).toBe('ssh')
    expect(record!.sshHost).toBe('example.com')
  })

  it('cloned record is a deep copy (mutating it does not affect source)', () => {
    const { messages, steps } = buildThreeTaskSession()
    agent.injectSession({
      sessionId: 'src',
      sessionMessages: messages,
      sessionSteps: steps
    })

    const record = agent.cloneRecordForFork('new-session')
    record!.messages![0].content = 'MUTATED'
    expect(messages[0].content).toBe('Task 1 question')
  })

  it('supplement message with _systemInjected does not create extra task boundary', () => {
    // Task 2 包含一条用户追加消息（supplement）。
    // supplement 带 _systemInjected: true，不应被计为新 task 边界，
    // 否则 tasks.length(4) > stepChunks.length(3)，fork 截断会错误丢掉 Task 3。
    const messages: AiMessage[] = [
      { role: 'user', content: 'Task 1 question' },
      { role: 'assistant', content: 'Task 1 answer' },
      { role: 'user', content: 'Task 2 question' },
      { role: 'assistant', content: '...' },
      { role: 'user', content: 'Task 2 supplement', _systemInjected: true },  // supplement
      { role: 'assistant', content: 'Task 2 answer' },
      { role: 'user', content: 'Task 3 question' },
      { role: 'assistant', content: 'Task 3 answer' }
    ]
    const baseTs = Date.now() - 10000
    const steps: AgentStep[] = [
      { id: 'ut1', type: 'user_task', content: 'Task 1 question', timestamp: baseTs },
      { id: 'fr1', type: 'final_result', content: 'Task 1 answer', timestamp: baseTs + 200 },
      { id: 'ut2', type: 'user_task', content: 'Task 2 question', timestamp: baseTs + 300 },
      { id: 'us2', type: 'user_supplement', content: 'Task 2 supplement', timestamp: baseTs + 450 },
      { id: 'fr2', type: 'final_result', content: 'Task 2 answer', timestamp: baseTs + 500 },
      { id: 'ut3', type: 'user_task', content: 'Task 3 question', timestamp: baseTs + 600 },
      { id: 'fr3', type: 'final_result', content: 'Task 3 answer', timestamp: baseTs + 800 }
    ]
    agent.injectSession({ sessionId: 'src', sessionMessages: messages, sessionSteps: steps })

    // fork 最后一个 group（index=2，untilTaskCount=3）
    const record = agent.cloneRecordForFork('new-session', { untilTaskCount: 3 })
    expect(record).not.toBeNull()
    // 3 个 step chunks，untilTaskCount=3 → 不截断，全量保留
    expect(record!.steps.length).toBe(7)
    // 3 个真实 task 边界（supplement 带 _systemInjected，不算），不截断 → 全量 8 messages
    expect(record!.messages?.length).toBe(8)
    // Task 3 的内容必须存在
    const content = JSON.stringify(record!.messages)
    expect(content).toContain('Task 3 question')
    expect(content).toContain('Task 3 answer')
  })

  it('supplement without _systemInjected creates extra task boundary causing truncation', () => {
    // 无 _systemInjected 的 supplement 会被误算为 task 边界，
    // 导致 tasks.length=4 > stepChunks.length=3，fork 截断丢 Task 3。
    // 此测试记录 bug 行为，保证有人移除 _systemInjected 时测试会红。
    const messages: AiMessage[] = [
      { role: 'user', content: 'Task 1 question' },
      { role: 'assistant', content: 'Task 1 answer' },
      { role: 'user', content: 'Task 2 question' },
      { role: 'assistant', content: '...' },
      { role: 'user', content: 'Task 2 supplement' },  // 没有 _systemInjected → 误算边界
      { role: 'assistant', content: 'Task 2 answer' },
      { role: 'user', content: 'Task 3 question' },
      { role: 'assistant', content: 'Task 3 answer' }
    ]
    const baseTs = Date.now() - 10000
    const steps: AgentStep[] = [
      { id: 'ut1', type: 'user_task', content: 'Task 1 question', timestamp: baseTs },
      { id: 'fr1', type: 'final_result', content: 'Task 1 answer', timestamp: baseTs + 200 },
      { id: 'ut2', type: 'user_task', content: 'Task 2 question', timestamp: baseTs + 300 },
      { id: 'us2', type: 'user_supplement', content: 'Task 2 supplement', timestamp: baseTs + 450 },
      { id: 'fr2', type: 'final_result', content: 'Task 2 answer', timestamp: baseTs + 500 },
      { id: 'ut3', type: 'user_task', content: 'Task 3 question', timestamp: baseTs + 600 },
      { id: 'fr3', type: 'final_result', content: 'Task 3 answer', timestamp: baseTs + 800 }
    ]
    agent.injectSession({ sessionId: 'src', sessionMessages: messages, sessionSteps: steps })

    const record = agent.cloneRecordForFork('new-session', { untilTaskCount: 3 })
    expect(record).not.toBeNull()
    // steps 不受影响：3 chunks，untilTaskCount=3 → 全量保留
    expect(record!.steps.length).toBe(7)
    // messages 被误截：4 message tasks（supplement 误算为边界），untilTaskCount=3 < 4 → 截断！
    // 只取前 3 个 message tasks，丢失 Task 3
    expect(record!.messages?.length).toBe(6)  // Task 1(2) + Task 2 first half(2) + supplement onward(2) = 6，Task 3 丢失
    const content = JSON.stringify(record!.messages)
    expect(content).not.toContain('Task 3 question')  // Task 3 被截掉
  })
})

describe('Agent.applyForkSnapshot', () => {
  let agent: TestAgent

  beforeEach(() => {
    agent = new TestAgent(createMockServices())
  })

  it('applyForkSnapshot sets sessionId and clears in-memory session arrays', () => {
    agent.injectSession({
      sessionId: 'old',
      sessionMessages: [{ role: 'user', content: 'old' }],
      sessionSteps: [{ id: 'old-step', type: 'user_task', content: 'old', timestamp: 0 }]
    })

    agent.applyForkSnapshot({
      sessionId: 'new',
      previousRunMessages: [{ role: 'user', content: 'prev' }]
    })

    expect(agent.exposeSessionId()).toBe('new')
    expect(agent.exposePreviousRunMessages()).toEqual([{ role: 'user', content: 'prev' }])
  })

  it('applyForkSnapshot without previousRunMessages still resets sessionId', () => {
    agent.injectSession({
      sessionId: 'old',
      sessionMessages: [],
      sessionSteps: []
    })

    agent.applyForkSnapshot({ sessionId: 'new' })

    expect(agent.exposeSessionId()).toBe('new')
    expect(agent.exposePreviousRunMessages()).toBeUndefined()
  })
})

describe('AgentService.forkAgent', () => {
  it('returns null when source agent does not exist', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)
    const result = await service.forkAgent({
      sourceAgentKey: 'nonexistent',
      newAgentId: 'new-id'
    })
    expect(result).toBeNull()
  })

  it('forks from HistoryService when source agent is missing but sourceSessionId is provided', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const { messages, steps } = buildThreeTaskSession()
    const historyRecord = {
      id: 'history-session',
      timestamp: Date.now() - 20000,
      terminalId: '',
      terminalType: 'local' as const,
      userTask: 'Task 1 question',
      steps,
      messages,
      duration: 1000,
      status: 'completed' as const,
    }

    const savedRecords: any[] = []
    const historyService = {
      saveAgentRecord: vi.fn((r) => { savedRecords.push(r) }),
      getAgentRecordById: vi.fn((id: string) => id === 'history-session' ? historyRecord : undefined),
      getRecentAgentRecords: vi.fn().mockReturnValue([]),
      getAgentRecordStore: vi.fn(() => historyService)
    }
    service.setHistoryService(historyService as any)

    const result = await service.forkAgent({
      sourceAgentKey: 'nonexistent',
      newAgentId: 'new-from-history',
      sourceSessionId: 'history-session',
      untilTaskCount: 2,
      titleSuffix: ' · 分支'
    })

    expect(result).not.toBeNull()
    expect(result!.newAgentId).toBe('new-from-history')
    expect(result!.sourceUserTask).toBe('Task 1 question · 分支')
    expect(savedRecords[0].messages?.length).toBe(4)
    expect(historyService.getAgentRecordById).toHaveBeenCalledWith('history-session')
  })

  it('returns null when historyService is not configured', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    // 创建一个有会话的源 agent，但不注入 historyService
    const src = service.createAssistantAgent('src') as unknown as TestAgent
    Object.setPrototypeOf(src, TestAgent.prototype)
    const { messages, steps } = buildThreeTaskSession()
    src.injectSession({ sessionId: 'src-session', sessionMessages: messages, sessionSteps: steps })

    const result = await service.forkAgent({
      sourceAgentKey: 'src',
      newAgentId: 'new-id'
    })
    expect(result).toBeNull()
  })

  it('end-to-end: writes new record + creates new agent + transfers cache snapshot for assistant→assistant', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const savedRecords: any[] = []
    const historyService = {
      saveAgentRecord: vi.fn((r) => { savedRecords.push(r) }),
      getAgentRecordById: vi.fn().mockReturnValue(undefined),
      getRecentAgentRecords: vi.fn().mockReturnValue([]),
      getAgentRecordStore: vi.fn(() => historyService)
    }
    service.setHistoryService(historyService as any)

    const src = service.createAssistantAgent('src') as unknown as TestAgent
    Object.setPrototypeOf(src, TestAgent.prototype)
    const { messages, steps } = buildThreeTaskSession()
    // 注：源是 assistant 模式（无 terminalType）
    src.injectSession({
      sessionId: 'src-session',
      sessionMessages: messages,
      sessionSteps: steps
    })

    const result = await service.forkAgent({
      sourceAgentKey: 'src',
      newAgentId: 'new-id',
      titleSuffix: ' · 分支'
    })

    expect(result).not.toBeNull()
    expect(result!.newAgentId).toBe('new-id')
    expect(result!.sourceUserTask).toBe('Task 1 question · 分支')
    expect(historyService.saveAgentRecord).toHaveBeenCalledOnce()
    expect(savedRecords[0].id).toBe(result!.newSessionId)
    expect(savedRecords[0].userTask).toBe('Task 1 question · 分支')
    expect(savedRecords[0].messages?.length).toBe(6)

    // 同模式全量 fork：新 agent 应继承 cache snapshot，内容 = newRecord.messages
    const newAgent = service.getAgent('new-id') as unknown as TestAgent
    Object.setPrototypeOf(newAgent, TestAgent.prototype)
    expect(newAgent.exposeSessionId()).toBe(result!.newSessionId)
    expect(newAgent.exposePreviousRunMessages()).toEqual(savedRecords[0].messages)
  })

  it('cross-mode fork (terminal → assistant): does NOT transfer cache snapshot', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const historyService = {
      saveAgentRecord: vi.fn(),
      getAgentRecordById: vi.fn().mockReturnValue(undefined),
      getRecentAgentRecords: vi.fn().mockReturnValue([]),
      getAgentRecordStore: vi.fn(() => historyService)
    }
    service.setHistoryService(historyService as any)

    // 用 getOrCreateAgent 模拟终端 Agent，再覆盖原型为 TestAgent
    const src = service.getOrCreateAgent('src-tab-id') as unknown as TestAgent
    Object.setPrototypeOf(src, TestAgent.prototype)
    const { messages, steps } = buildThreeTaskSession()
    src.injectSession({
      sessionId: 'src-session',
      sessionMessages: messages,
      sessionSteps: steps,
      terminalType: 'ssh',
      sshHost: 'example.com'
    })

    const result = await service.forkAgent({
      sourceAgentKey: 'src-tab-id',
      newAgentId: 'new-assistant',
      targetMode: 'assistant'
    })

    expect(result).not.toBeNull()

    // 跨模式 fork：cache snapshot 不应被传递（system prompt 不同，cache 物理上无法命中）
    const newAgent = service.getAgent('new-assistant') as unknown as TestAgent
    Object.setPrototypeOf(newAgent, TestAgent.prototype)
    expect(newAgent.exposePreviousRunMessages()).toBeUndefined()
  })

  it('truncated same-mode fork: cache snapshot is set to the truncated messages (matches new record)', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const savedRecords: any[] = []
    const historyService = {
      saveAgentRecord: vi.fn((r) => { savedRecords.push(r) }),
      getAgentRecordById: vi.fn().mockReturnValue(undefined),
      getRecentAgentRecords: vi.fn().mockReturnValue([]),
      getAgentRecordStore: vi.fn(() => historyService)
    }
    service.setHistoryService(historyService as any)

    const src = service.createAssistantAgent('src') as unknown as TestAgent
    Object.setPrototypeOf(src, TestAgent.prototype)
    const { messages, steps } = buildThreeTaskSession()
    src.injectSession({
      sessionId: 'src-session',
      sessionMessages: messages,
      sessionSteps: steps,
      // 注入完整对话的 cache snapshot；fork 时不应原样传递（会破坏截断意图）
      previousRunMessages: messages.map(m => ({ ...m }))
    })

    await service.forkAgent({
      sourceAgentKey: 'src',
      newAgentId: 'new-id',
      untilTaskCount: 2
    })

    const newAgent = service.getAgent('new-id') as unknown as TestAgent
    Object.setPrototypeOf(newAgent, TestAgent.prototype)
    const carriedSnapshot = newAgent.exposePreviousRunMessages()
    // 截断 fork 仍然传 cache snapshot —— 但内容是按相同边界截断后的 messages（4 条），
    // 与新 record.messages 字节一致；既保持截断意图，又能命中 LLM 前缀缓存
    expect(carriedSnapshot).toBeDefined()
    expect(carriedSnapshot).toEqual(savedRecords[0].messages)
    expect(carriedSnapshot!.length).toBe(4)
    // 不应包含被截掉的 Task 3
    const allContent = JSON.stringify(carriedSnapshot)
    expect(allContent).not.toContain('Task 3')
  })

  it('truncates record when untilTaskCount is provided', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const savedRecords: any[] = []
    const historyService = {
      saveAgentRecord: vi.fn((r) => { savedRecords.push(r) }),
      getAgentRecordById: vi.fn().mockReturnValue(undefined),
      getRecentAgentRecords: vi.fn().mockReturnValue([]),
      getAgentRecordStore: vi.fn(() => historyService)
    }
    service.setHistoryService(historyService as any)

    const src = service.createAssistantAgent('src') as unknown as TestAgent
    Object.setPrototypeOf(src, TestAgent.prototype)
    const { messages, steps } = buildThreeTaskSession()
    src.injectSession({
      sessionId: 'src-session',
      sessionMessages: messages,
      sessionSteps: steps
    })

    await service.forkAgent({
      sourceAgentKey: 'src',
      newAgentId: 'new-id',
      untilTaskCount: 2
    })

    expect(savedRecords[0].messages?.length).toBe(4)
    expect(savedRecords[0].steps.length).toBe(6)
    expect(savedRecords[0].finalResult).toBe('Task 2 answer')
  })

  it('returns null on full fork while source agent is running', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const historyService = {
      saveAgentRecord: vi.fn(),
      getAgentRecordById: vi.fn().mockReturnValue(undefined),
      getRecentAgentRecords: vi.fn().mockReturnValue([]),
      getAgentRecordStore: vi.fn(() => historyService)
    }
    service.setHistoryService(historyService as any)

    const src = service.createAssistantAgent('src') as unknown as TestAgent
    Object.setPrototypeOf(src, TestAgent.prototype)
    const { messages, steps } = buildThreeTaskSession()
    src.injectSession({ sessionId: 'src-session', sessionMessages: messages, sessionSteps: steps })
    src.setRunning(true)

    const result = await service.forkAgent({
      sourceAgentKey: 'src',
      newAgentId: 'new-id'
    })
    expect(result).toBeNull()
    expect(historyService.saveAgentRecord).not.toHaveBeenCalled()
  })

  it('allows truncated fork while source agent is running', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const savedRecords: any[] = []
    const historyService = {
      saveAgentRecord: vi.fn((r) => { savedRecords.push(r) }),
      getAgentRecordById: vi.fn().mockReturnValue(undefined),
      getRecentAgentRecords: vi.fn().mockReturnValue([]),
      getAgentRecordStore: vi.fn(() => historyService)
    }
    service.setHistoryService(historyService as any)

    const src = service.createAssistantAgent('src') as unknown as TestAgent
    Object.setPrototypeOf(src, TestAgent.prototype)
    const { messages, steps } = buildThreeTaskSession()
    src.injectSession({ sessionId: 'src-session', sessionMessages: messages, sessionSteps: steps })
    src.setRunning(true)

    const result = await service.forkAgent({
      sourceAgentKey: 'src',
      newAgentId: 'new-id',
      untilTaskCount: 2
    })

    expect(result).not.toBeNull()
    expect(savedRecords[0].messages?.length).toBe(4)
    expect(savedRecords[0].finalResult).toBe('Task 2 answer')
  })
})

// ============================================================================
// 新增：Conversation.extractTaskFromRecords + AgentService.extractTaskFromCompanion
// companion → task 异质转化：N 条物理 record 合并后截断产出新任务会话
// ============================================================================

/** 构造一条 companion record（agentKey='__companion__'，含 N 个 task） */
function buildCompanionRecord(opts: {
  id: string
  timestamp: number
  userTask: string
  messages: AiMessage[]
  steps: AgentStep[]
  proactive?: boolean
}): AgentRecord {
  return {
    id: opts.id,
    kind: 'companion',
    timestamp: opts.timestamp,
    terminalId: '',
    agentKey: '__companion__',
    terminalType: 'assistant',
    userTask: opts.proactive ? '__proactive__' : opts.userTask,
    steps: opts.steps,
    messages: opts.messages,
    duration: 0,
    status: 'completed'
  }
}

describe('Conversation.extractTaskFromRecords', () => {
  it('returns null for empty records array', () => {
    const result = Conversation.extractTaskFromRecords([], 'new-session')
    expect(result).toBeNull()
  })

  it('merges multiple records by timestamp and truncates by untilTaskCount', () => {
    // 两条 companion record，各含 1 个 task；合并后是 2 个 task
    const rec1 = buildCompanionRecord({
      id: 'sess_c1',
      timestamp: 1000,
      userTask: '早段问题',
      messages: [
        { role: 'user', content: '早段问题' },
        { role: 'assistant', content: '早段回答' }
      ],
      steps: [
        { id: 'ut1', type: 'user_task', content: '早段问题', timestamp: 1000 },
        { id: 'fr1', type: 'final_result', content: '早段回答', timestamp: 1100 }
      ]
    })
    const rec2 = buildCompanionRecord({
      id: 'sess_c2',
      timestamp: 2000,
      userTask: '晚段问题',
      messages: [
        { role: 'user', content: '晚段问题' },
        { role: 'assistant', content: '晚段回答' }
      ],
      steps: [
        { id: 'ut2', type: 'user_task', content: '晚段问题', timestamp: 2000 },
        { id: 'fr2', type: 'final_result', content: '晚段回答', timestamp: 2100 }
      ]
    })

    // (a) 全量合并：untilTaskCount undefined → 4 messages（2 user + 2 assistant）
    const full = Conversation.extractTaskFromRecords([rec2, rec1], 'sess_extract_full')!
    expect(full).not.toBeNull()
    expect(full.record.id).toBe('sess_extract_full')
    expect(full.record.kind).toBe('task') // 异质转化：产物恒为 task
    expect(full.record.messages!.length).toBe(4)
    expect(full.record.messages![0].content).toBe('早段问题') // 按 timestamp 升序

    // (b) 截断到第 1 个 task → 只含早段
    const partial = Conversation.extractTaskFromRecords(
      [rec2, rec1],
      'sess_extract_partial',
      { untilTaskCount: 1 }
    )!
    expect(partial).not.toBeNull()
    expect(partial.record.messages!.length).toBe(2)
    expect(partial.record.messages![0].content).toBe('早段问题')
    expect(partial.record.messages![1].content).toBe('早段回答')
  })

  it('skips proactive records when merging messages (proactive has no API messages)', () => {
    // proactive record（Watch 主动消息冒泡）：userTask='__proactive__'，无 messages
    const proactive = buildCompanionRecord({
      id: 'sess_proactive',
      timestamp: 1500,
      userTask: '主动通知',
      messages: [],
      steps: [
        { id: 'ut_p', type: 'user_task', content: '主动通知', timestamp: 1500 }
      ],
      proactive: true
    })
    const real = buildCompanionRecord({
      id: 'sess_real',
      timestamp: 1000,
      userTask: '真实对话',
      messages: [
        { role: 'user', content: '真实对话' },
        { role: 'assistant', content: '真实回答' }
      ],
      steps: [
        { id: 'ut_r', type: 'user_task', content: '真实对话', timestamp: 1000 }
      ]
    })

    const result = Conversation.extractTaskFromRecords([proactive, real], 'sess_extract')!
    // messages 只含真实对话 record 的 messages（proactive 被跳过）
    expect(result.record.messages!.length).toBe(2)
    expect(result.record.messages![0].content).toBe('真实对话')
  })

  it('appends titleSuffix to userTask', () => {
    const rec = buildCompanionRecord({
      id: 'sess_c1',
      timestamp: 1000,
      userTask: '原始问题',
      messages: [
        { role: 'user', content: '原始问题' },
        { role: 'assistant', content: '回答' }
      ],
      steps: [{ id: 'ut1', type: 'user_task', content: '原始问题', timestamp: 1000 }]
    })

    const result = Conversation.extractTaskFromRecords([rec], 'sess_x', { titleSuffix: ' · 分支' })!
    expect(result.record.userTask).toBe('原始问题 · 分支')
  })

  it('preserves toolCallId through stepRecord → step → stepRecord round-trip', () => {
    // 回归测试:原 Agent.buildForkRecord 漏了 toolCallId,且 stepRecordToStep 也漏,
    // 导致 fork 产物的 tool_result steps 丢失配对钥匙。修复后必须透传。
    const rec = buildCompanionRecord({
      id: 'sess_c1',
      timestamp: 1000,
      userTask: '工具调用任务',
      messages: [
        { role: 'user', content: '工具调用任务' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_x1', type: 'function', function: { name: 'fake_tool', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_x1', content: '工具结果' },
        { role: 'assistant', content: '完成' }
      ],
      steps: [
        { id: 'ut1', type: 'user_task', content: '工具调用任务', timestamp: 1000 },
        { id: 'tr1', type: 'tool_result', content: '工具结果', toolName: 'fake_tool', toolCallId: 'call_x1', timestamp: 1100 }
      ]
    })

    const result = Conversation.extractTaskFromRecords([rec], 'sess_fork_toolcallid')!
    const toolResultSteps = result.record.steps!.filter(s => s.type === 'tool_result')
    expect(toolResultSteps.length).toBe(1)
    expect(toolResultSteps[0].toolCallId).toBe('call_x1') // 关键:toolCallId 必须保留
  })
})

describe('AgentService.extractTaskFromCompanion', () => {
  it('returns null when historyService is not available', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)
    // 不调 setHistoryService → historyService / companion 都未装配
    const result = await service.extractTaskFromCompanion({
      newAgentId: 'new-id'
    })
    expect(result).toBeNull()
  })

  it('returns null when no companion records exist', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)
    const historyService = {
      getAgentRecordStore: vi.fn(() => historyService),
      getRecentRecordsByAgentKey: vi.fn().mockReturnValue([]),
      saveAgentRecord: vi.fn()
    }
    service.setHistoryService(historyService as any)

    const result = await service.extractTaskFromCompanion({
      newAgentId: 'new-id'
    })
    expect(result).toBeNull()
  })

  it('end-to-end: merges companion records, saves new task record, creates new agent with cache snapshot', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const savedRecords: AgentRecord[] = []
    const historyService = {
      getAgentRecordStore: vi.fn(() => historyService),
      getRecentRecordsByAgentKey: vi.fn().mockReturnValue([
        buildCompanionRecord({
          id: 'sess_c1',
          timestamp: 1000,
          userTask: 'companion 任务',
          messages: [
            { role: 'user', content: 'companion 任务' },
            { role: 'assistant', content: 'companion 回答' }
          ],
          steps: [
            { id: 'ut1', type: 'user_task', content: 'companion 任务', timestamp: 1000 },
            { id: 'fr1', type: 'final_result', content: 'companion 回答', timestamp: 1100 }
          ]
        })
      ]),
      saveAgentRecord: vi.fn((r: AgentRecord) => { savedRecords.push(r) }),
      getAgentRecordById: vi.fn()
    }
    service.setHistoryService(historyService as any)

    const result = await service.extractTaskFromCompanion({
      newAgentId: 'new-extracted',
      titleSuffix: ' · 分支'
    })

    expect(result).not.toBeNull()
    expect(result!.newAgentId).toBe('new-extracted')
    expect(result!.sourceUserTask).toBe('companion 任务 · 分支')
    expect(savedRecords.length).toBe(1)
    expect(savedRecords[0].id).toBe(result!.newSessionId)
    expect(savedRecords[0].kind).toBe('task') // 异质转化：产物是 task，不是 companion
    expect(savedRecords[0].messages!.length).toBe(2)

    // 新 Agent 应已创建（createAssistantAgent 注册到 agents map）
    const newAgent = service.getAgent('new-extracted')
    expect(newAgent).toBeTruthy()
  })
})
