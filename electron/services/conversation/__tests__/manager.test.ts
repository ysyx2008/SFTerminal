/**
 * ConversationManager 单测：钉住「按 kind 策略决策」与「查询委托」两件事。
 *
 * 重点：resolveSeedSessionId 必须忠实复刻旧 Agent.run 初始化里的回种分支
 * （companion 冷启动回种 / suppressSeed 抑制 / task·watch 不回种），这是
 * 「联络裂成两条 session」防回归的核心口径。
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
import { ConversationStore } from '../storage'
import { ConversationManager } from '../manager'
import type { AgentRecord } from '@shared/types'

function rec(id: string, overrides?: Partial<AgentRecord>): AgentRecord {
  return {
    id,
    timestamp: Date.now(),
    terminalId: '',
    terminalType: 'assistant',
    agentKey: 'tab-1',
    userTask: `任务 ${id}`,
    steps: [],
    messages: [{ role: 'user', content: id }, { role: 'assistant', content: `re ${id}` }],
    duration: 0,
    status: 'completed',
    ...overrides
  } as AgentRecord
}

function mgr(): ConversationManager {
  return new ConversationManager(new ConversationStore(new HistoryService()))
}

describe('ConversationManager', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-conv-mgr-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('seedsFromHistory（== 旧 _persistentNamedAgent：持久命名 Agent）', () => {
    it('companion + watch 回种；task / undefined 不回种', () => {
      const m = mgr()
      expect(m.seedsFromHistory('__companion__')).toBe(true)
      expect(m.seedsFromHistory('__watch__')).toBe(true) // 桌面 watch 也是持久命名 Agent
      expect(m.seedsFromHistory('tab-123')).toBe(false)
      expect(m.seedsFromHistory(undefined)).toBe(false)
    })
  })

  describe('resolveSeedSessionId', () => {
    it('入口显式带 sessionId：直接用（漫游/恢复）', () => {
      const r = mgr().resolveSeedSessionId({
        agentKey: 'tab-A',
        contextSessionId: 'sess_explicit',
        contextStartTime: 123
      })
      expect(r).toEqual({ sessionId: 'sess_explicit', startTime: 123 })
    })

    it('companion 无 sessionId：从最近一条历史回种（不新起 session_）', () => {
      const m = mgr()
      m.conversationStore.save(
        rec('session_persisted_companion', { agentKey: '__companion__', timestamp: 1000 })
      )
      // 换实例强制走盘
      const fresh = mgr()
      const r = fresh.resolveSeedSessionId({ agentKey: '__companion__' })
      expect(r.sessionId).toBe('session_persisted_companion')
      expect(r.startTime).toBe(1000)
    })

    it('companion 无 sessionId 且 suppressSeed：抑制回种，新起 session_', () => {
      const m = mgr()
      m.conversationStore.save(rec('session_old', { agentKey: '__companion__' }))
      const fresh = mgr()
      const r = fresh.resolveSeedSessionId({ agentKey: '__companion__', suppressSeed: true })
      expect(r.sessionId).toMatch(/^session_\d+/)
      expect(r.sessionId).not.toBe('session_old')
    })

    it('companion 无历史：回种无果，新起 session_', () => {
      const r = mgr().resolveSeedSessionId({ agentKey: '__companion__' })
      expect(r.sessionId).toMatch(/^session_\d+/)
    })

    it('task 无 sessionId：恒新起 session_，不查历史回种', () => {
      const m = mgr()
      m.conversationStore.save(rec('session_task_old', { agentKey: 'tab-X', timestamp: 1000 }))
      const fresh = mgr()
      expect(fresh.resolveSeedSessionId({ agentKey: 'tab-X' }).sessionId).toMatch(/^session_\d+/)
    })

    it('watch 现状（startNewSession→suppressSeed=true）：新起独立 session_，不回种', () => {
      // 这是桌面 watch 的真实路径：每次执行先 startNewSession 抑制回种，保持独立记录。
      const m = mgr()
      m.conversationStore.save(rec('watch_w_old', { agentKey: '__watch__', timestamp: 1000 }))
      const fresh = mgr()
      const r = fresh.resolveSeedSessionId({ agentKey: '__watch__', suppressSeed: true })
      expect(r.sessionId).toMatch(/^session_\d+/)
      expect(r.sessionId).not.toBe('watch_w_old')
    })

    it('watch 即使未抑制也新起：其历史在独立 watch 树，latestByAgentKey（主树）查不到', () => {
      // 关键保真：watch 虽是持久命名 Agent（seedsFromHistory=true），但 watch 记录被路由到
      // 独立 watch 树，而回种用的 latestByAgentKey 只查主树 → 恒 undefined → 恒新起 session_。
      // 这正是 watch 内心独白「逐次独立记录」在存储层的根因。
      const m = mgr()
      m.conversationStore.save(rec('watch_w_seed', { agentKey: '__watch__', timestamp: 1000 }))
      const fresh = mgr()
      expect(fresh.latestByAgentKey('__watch__')).toBeUndefined()
      expect(fresh.resolveSeedSessionId({ agentKey: '__watch__' }).sessionId).toMatch(/^session_\d+/)
    })
  })

  describe('查询委托', () => {
    it('getRecord / latestByAgentKey / recent / listSummaries 透传 Store 语义', () => {
      const m = mgr()
      m.conversationStore.save(rec('sess_q1', { agentKey: 'tab-1', timestamp: Date.now() - 2000 }))
      m.conversationStore.save(rec('sess_q2', { agentKey: 'tab-1', timestamp: Date.now() }))
      m.conversationStore.save(rec('watch_q', { agentKey: '__watch__' }))

      const fresh = mgr()
      expect(fresh.getRecord('sess_q1')!.id).toBe('sess_q1')
      expect(fresh.latestByAgentKey('tab-1')!.id).toBe('sess_q2')
      // 任务侧栏口径不含 watch
      expect(fresh.listSummaries(true).some(s => s.id === 'watch_q')).toBe(false)
      // watch 进独立树
      expect(fresh.recentWatch(20).some(r => r.id === 'watch_q')).toBe(true)
    })

    it('delete 透传', () => {
      const m = mgr()
      m.conversationStore.save(rec('sess_del'))
      expect(m.delete('sess_del')).toBe(true)
      expect(mgr().getRecord('sess_del')).toBeUndefined()
    })
  })
})
