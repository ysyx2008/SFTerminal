/**
 * 集成测试：联络（__companion__）会话跨重启恢复 —— 真实 HistoryService 磁盘往返
 *
 * agent.test.ts 把 HistoryService 整个 mock 掉了，只验证「调了哪个方法、taskCount 多少」，
 * 没覆盖真正的磁盘往返。本测试用**真实 HistoryService**（仅 mock electron 的 userData 指向
 * 临时目录、不 mock fs），端到端复现「重启 + IM 无 sessionId 入口」的真实场景，验证：
 *   ① 重启后 IM 入口（context 不带 sessionId）会从磁盘最近一条 __companion__ 记录回种
 *      sessionId，而不是新起 session_${Date.now()} 建出断链的并行记录；
 *   ② 续聊续写到原记录，不裂出第二条；
 *   ③ 之前写文档那条任务被 restore 进工作记忆。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

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
        (_m: unknown, _t: unknown, onChunk: (s: string) => void, _otc: unknown, onDone: (r: unknown) => void) => {
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

function companionCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    terminalOutput: [],
    systemInfo: { os: 'darwin', shell: '/bin/zsh' },
    terminalType: 'assistant',
    ...overrides
  } as AgentContext
}

function newCompanion(history: HistoryService): TestAgent {
  const agent = new TestAgent(makeServices(history))
  agent.setAgentId('__companion__')
  agent.markAsPersistentNamed()
  return agent
}

describe('Companion 跨重启恢复（集成 · 真实 HistoryService 磁盘往返）', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-companion-it-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('重启后 IM 无 sessionId 入口从磁盘回种 sessionId，续写原记录、不裂第二条', async () => {
    // —— 会话1：桌面带 sessionId 跑一次，落一条 __companion__ 记录到磁盘 ——
    const history1 = new HistoryService()
    const a1 = newCompanion(history1)
    await a1.run('帮我写个中证协的案例文档', companionCtx({
      sessionId: 'session_desktop_1',
      sessionStartTime: Date.now() - 60000
    }))

    const onDisk = history1.getRecentRecordsByAgentKey('__companion__', 10)
    expect(onDisk.length).toBe(1)
    expect(onDisk[0].id).toBe('session_desktop_1')
    expect(onDisk[0].agentKey).toBe('__companion__')

    // —— 模拟重启：全新 HistoryService（重新读盘）+ 全新 Agent 实例 ——
    const history2 = new HistoryService()
    const a2 = newCompanion(history2)

    // IM 入口：context 不带 sessionId
    await a2.run('继续', companionCtx())

    // ① 回种到磁盘最近一条，而非新起 session_${Date.now()}
    expect(a2.getSessionId()).toBe('session_desktop_1')

    // ③ 工作记忆里能看到之前写文档那条（restore 自磁盘）+ 当前「继续」
    expect(a2.exposeTaskMemory().getTaskCount()).toBeGreaterThanOrEqual(2)

    // ② 没有裂出第二条记录：续写到原 id，仍只有 1 条 __companion__
    const after = new HistoryService().getRecentRecordsByAgentKey('__companion__', 10)
    expect(after.length).toBe(1)
    expect(after[0].id).toBe('session_desktop_1')
  })

  it('清空对话（resetSession）后 IM 入口不回种，开全新会话', async () => {
    const history1 = new HistoryService()
    const a1 = newCompanion(history1)
    await a1.run('旧对话', companionCtx({ sessionId: 'session_old', sessionStartTime: Date.now() - 60000 }))
    expect(history1.getRecentRecordsByAgentKey('__companion__', 10).length).toBe(1)

    // 同一实例「清空对话」后再来消息（无 sessionId）：应抑制回种、开全新会话
    a1.resetSession()
    await a1.run('全新开始', companionCtx())

    expect(a1.getSessionId()).not.toBe('session_old')
    expect(a1.getSessionId()).toMatch(/^session_\d+$/)

    // 磁盘上应出现第二条独立记录（全新会话）
    const after = new HistoryService().getRecentRecordsByAgentKey('__companion__', 10)
    expect(after.length).toBe(2)
  })
})
