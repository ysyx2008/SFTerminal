/**
 * Companion.formatRecentTurnsForWatchPrompt —— 心跳/Watch 注入联络上下文的单测。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

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

import { HistoryService } from '../../history.service'
import { Companion } from '../companion'
import type { AgentRecord } from '@shared/types'

function companionRec(
  id: string,
  overrides?: Partial<AgentRecord>
): AgentRecord {
  return {
    id,
    kind: 'companion',
    timestamp: Date.now(),
    terminalId: '',
    agentKey: '__companion__',
    terminalType: 'assistant',
    userTask: `联络 ${id}`,
    steps: [],
    messages: [],
    duration: 0,
    status: 'completed',
    ...overrides
  } as AgentRecord
}

describe('Companion.formatRecentTurnsForWatchPrompt', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-companion-watch-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('合并多条 companion record 的 messages，心跳能看到联络 tab 近期对话', () => {
    const hs = new HistoryService()
    const t0 = Date.now() - 60_000
    const t1 = Date.now()

    hs.saveAgentRecord(companionRec('sess_old', {
      timestamp: t0,
      messages: [
        { role: 'user', content: '胡宇明天来实习' },
        { role: 'assistant', content: '好的，我会提醒你' }
      ]
    }))
    hs.saveAgentRecord(companionRec('sess_new', {
      timestamp: t1,
      messages: [
        { role: 'user', content: '你提醒了我几次，你可知道' },
        { role: 'assistant', content: '我提醒了你 3 次，以后只提醒一次' },
        { role: 'user', content: '我怀疑你在心跳的时候看不到这些历史记录' }
      ]
    }))

    const text = new Companion(hs).formatRecentTurnsForWatchPrompt()
    expect(text).toContain('最近与用户的联络记录')
    expect(text).toContain('用户：你提醒了我几次')
    expect(text).toContain('你：我提醒了你 3 次')
    expect(text).toContain('用户：我怀疑你在心跳的时候看不到这些历史记录')
  })

  it('proactive_notice step 作为 assistant 轮次展示', () => {
    const hs = new HistoryService()
    hs.saveAgentRecord(companionRec('sess_pro', {
      userTask: '__proactive__',
      messages: [],
      steps: [
        { id: 'pn1', type: 'proactive_notice', content: '胡宇明天 10:30 报到', timestamp: Date.now() },
        { id: 'ut1', type: 'user_task', content: '知道了别重复说', timestamp: Date.now() + 1 },
        { id: 'fr1', type: 'final_result', content: '收到，以后只提醒一次', timestamp: Date.now() + 2 }
      ]
    }))

    const text = new Companion(hs).formatRecentTurnsForWatchPrompt()
    expect(text).toContain('你：胡宇明天 10:30 报到')
    expect(text).toContain('用户：知道了别重复说')
  })

  it('不截断单条消息正文', () => {
    const hs = new HistoryService()
    const long = '很长'.repeat(150)
    hs.saveAgentRecord(companionRec('sess_long', {
      messages: [
        { role: 'user', content: long },
        { role: 'assistant', content: '收到' }
      ]
    }))

    const text = new Companion(hs).formatRecentTurnsForWatchPrompt()
    expect(text).toContain(long)
    expect(text).not.toContain('…')
  })

  it('默认取最近 50 条，超出部分截断', () => {
    const hs = new HistoryService()
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (let i = 0; i < 60; i++) {
      messages.push({ role: 'user', content: `用户消息 ${i}` })
      messages.push({ role: 'assistant', content: `回复 ${i}` })
    }
    hs.saveAgentRecord(companionRec('sess_many', { messages }))

    const text = new Companion(hs).formatRecentTurnsForWatchPrompt()
    // 120 条消息（60 对），保留最近 50 条 → 从 user 35 起
    expect(text).toContain('用户：用户消息 59')
    expect(text).not.toContain('用户：用户消息 0')
    expect(text).not.toContain('用户：用户消息 34')
    expect(text).toContain('用户：用户消息 35')
  })
})
