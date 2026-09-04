/**
 * 联络五档 / 任务原文 / 唤醒概要：经真实 HistoryService 磁盘往返 + Agent.run。
 * 对上 SPEC：两条线不要混成一种装法；联络先多记做过什么。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ConversationManager, ConversationStore } from '../../conversation'
import type { AgentRecord } from '@shared/types'

let tmpDir: string
let messagesByCall: any[][] = []

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

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

import { Agent } from '../agent'
import { HistoryService } from '../../history.service'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext, AgentServices, PromptOptions } from '../types'

const HUGE_OLD = `OLD_TOOL_BODY_${'X'.repeat(3000)}`
const HAND_OFF = '[交接] 周报写在 /tmp/handoff.docx，结论已补上。'

class TestAgent extends Agent {
  getAvailableTools(): ToolDefinition[] {
    return []
  }
  protected buildSystemPrompt(_context: AgentContext, options?: PromptOptions): string {
    const extras = [
      options?.taskSummaries,
      options?.availableTaskIds?.map(t => t.summary).join('\n')
    ].filter(Boolean)
    return ['test system prompt', ...extras].join('\n')
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
    historyService: history as any,
    conversationManager: new ConversationManager(new ConversationStore(history.getAgentRecordStore()))
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

function newAgent(history: HistoryService, agentKey: string): TestAgent {
  const agent = new TestAgent(makeServices(history))
  agent.setAgentId(agentKey)
  if (agentKey.startsWith('__')) agent.markAsPersistentNamed()
  return agent
}

function flatten(messages: any[]): string {
  return messages.map(m => {
    const args = m.tool_calls?.map((tc: any) => `${tc.function?.name} ${tc.function?.arguments}`).join('\n') ?? ''
    return `${typeof m.content === 'string' ? m.content : ''}\n${args}`
  }).join('\n')
}

function twelveTurnMessages() {
  const messages: any[] = []
  for (let i = 0; i < 12; i++) {
    const id = `c${i}`
    messages.push({ role: 'user', content: `请打开报告 ${i} 号文档.docx` })
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{
        id,
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: `/tmp/doc_${i}.docx` }) }
      }]
    })
    messages.push({
      role: 'tool',
      content: i === 0 ? HUGE_OLD : `ok ${i}`,
      tool_call_id: id
    })
    messages.push({ role: 'assistant', content: `已经打开 doc_${i}.docx` })
  }
  return messages
}

function record(partial: Partial<AgentRecord> & Pick<AgentRecord, 'id' | 'agentKey' | 'userTask'>): AgentRecord {
  const timestamp = partial.timestamp ?? Date.now()
  return {
    timestamp,
    terminalId: 'pty-1',
    terminalType: 'assistant',
    steps: [
      { id: 'ut', type: 'user_task', content: partial.userTask, timestamp },
      { id: 'fr', type: 'final_result', content: 'done', timestamp }
    ],
    duration: 1000,
    status: 'completed',
    ...partial
  }
}

function qaTurns(prefix: string, count: number) {
  const messages: any[] = []
  for (let i = 0; i < count; i++) {
    messages.push({ role: 'user', content: `${prefix}_TURN_${i}` })
    messages.push({ role: 'assistant', content: `${prefix}_DONE_${i}` })
  }
  return messages
}

describe('端到端：联络五档 / 任务原文 / 唤醒概要', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-levels-e2e-'))
    messagesByCall = []
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('联络冷启动：远轮留下原话和收场，巨大过程不回来；近轮带着过程', async () => {
    const history1 = new HistoryService()
    history1.saveAgentRecord(record({
      id: 'sess_companion_levels',
      agentKey: '__companion__',
      kind: 'companion',
      userTask: '请打开报告 0 号文档.docx',
      messages: twelveTurnMessages()
    }))

    const a2 = newAgent(new HistoryService(), '__companion__')
    await a2.run('打开你前面写的那个 Word', ctx({ sessionId: 'sess_companion_levels' }))

    const text = flatten(messagesByCall[0])
    expect(text).toContain('请打开报告 0 号文档.docx')
    expect(text).toContain('已经打开 doc_0.docx')
    expect(text).not.toContain(HUGE_OLD)
    expect(text).toContain('/tmp/doc_11.docx')
    expect(text).toContain('请打开报告 11 号文档.docx')
  })

  it('同样十二轮在任务里走原文：远轮巨大过程还在', async () => {
    const history1 = new HistoryService()
    history1.saveAgentRecord(record({
      id: 'sess_task_originals',
      agentKey: 'tab-word',
      kind: 'task',
      userTask: '请打开报告 0 号文档.docx',
      messages: twelveTurnMessages()
    }))

    const a2 = newAgent(new HistoryService(), 'tab-word')
    await a2.run('打开你前面写的那个 Word', ctx({ sessionId: 'sess_task_originals' }))

    const text = flatten(messagesByCall[0])
    expect(text).toContain('请打开报告 0 号文档.docx')
    expect(text).toContain(HUGE_OLD)
    expect(text).toContain('/tmp/doc_0.docx')
  })

  it('联络重启只装最近 6 条记录里的轮次，更早的记不住', async () => {
    const history1 = new HistoryService()
    const base = Date.now() - 100_000
    for (let i = 0; i < 10; i++) {
      history1.saveAgentRecord(record({
        id: `sess_comp_${i}`,
        agentKey: '__companion__',
        kind: 'companion',
        userTask: `REC_${i}_TURN_0`,
        timestamp: base + i * 1000,
        messages: qaTurns(`REC_${i}`, 8)
      }))
    }

    const a2 = newAgent(new HistoryService(), '__companion__')
    await a2.run('继续', ctx({ sessionId: 'sess_comp_9' }))

    const requests = a2.exposeTaskMemory().getTasksInOrder().map(t => t.userRequest)
    expect(requests.some(r => r.includes('REC_0_TURN_0'))).toBe(false)
    expect(requests.some(r => r.includes('REC_3_TURN_0'))).toBe(false)
    expect(requests.some(r => r.includes('REC_4_TURN_0'))).toBe(true)
    expect(requests.some(r => r.includes('REC_9_TURN_0'))).toBe(true)
    expect(a2.exposeTaskMemory().getTaskCount()).toBeLessThanOrEqual(49)
  })

  it('联络有交接检查点时接着检查点，不把已交原文展开', async () => {
    const history1 = new HistoryService()
    history1.saveAgentRecord(record({
      id: 'sess_companion_handoff',
      agentKey: '__companion__',
      kind: 'companion',
      userTask: '请打开报告 0 号文档.docx',
      messages: twelveTurnMessages(),
      workingContext: [
        { role: 'user', content: HAND_OFF },
        { role: 'assistant', content: '结论已补上' }
      ]
    }))

    const a2 = newAgent(new HistoryService(), '__companion__')
    await a2.run('继续', ctx({ sessionId: 'sess_companion_handoff' }))

    const text = flatten(messagesByCall[0])
    expect(text).toContain(HAND_OFF)
    expect(text).not.toContain(HUGE_OLD)
    expect(text).not.toContain('请打开报告 0 号文档.docx')
  })

  it('唤醒只要一句话概要，不把同一场原文过程灌进去', async () => {
    const history1 = new HistoryService()
    history1.saveAgentRecord(record({
      id: 'sess_task_for_wakeup',
      agentKey: 'tab-ops',
      kind: 'task',
      userTask: '请打开报告 0 号文档.docx',
      messages: twelveTurnMessages()
    }))

    const a2 = newAgent(new HistoryService(), '__wakeup__')
    await a2.run('心跳检查', ctx({ wakeup: true }))

    const text = flatten(messagesByCall[0])
    expect(text).not.toContain(HUGE_OLD)
    expect(text).not.toContain('/tmp/doc_11.docx')
    expect(text).toMatch(/请打开报告 0|报告 0/)
  })
})
