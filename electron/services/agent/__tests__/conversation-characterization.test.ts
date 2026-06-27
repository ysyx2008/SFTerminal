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
}

function makeServices(history: HistoryService): AgentServices {
  return {
    aiService: {
      chatWithToolsStream: vi.fn(
        (messages: any[], _t: unknown, onChunk: (s: string) => void, _otc: unknown, onDone: (r: unknown) => void) => {
          messagesByCall.push(JSON.parse(JSON.stringify(messages)))
          onChunk('好的')
          onDone({ content: '好的', tool_calls: undefined })
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
function newTabAgent(history: HistoryService, agentKey: string): TestAgent {
  const agent = new TestAgent(makeServices(history))
  agent.setAgentId(agentKey)
  return agent
}

/** 持久命名 Agent（companion/watch） */
function newNamedAgent(history: HistoryService, agentKey: string): TestAgent {
  const agent = new TestAgent(makeServices(history))
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
})
