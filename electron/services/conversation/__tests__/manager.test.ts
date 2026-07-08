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
  return new ConversationManager(new ConversationStore(new HistoryService().getAgentRecordStore()))
}

describe('ConversationManager', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-conv-mgr-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('seedsFromHistory（== 旧 _persistentNamedAgent：持久命名 Agent）', () => {
    it('companion + wakeup 回种；watch / task / undefined 不回种', () => {
      const m = mgr()
      expect(m.seedsFromHistory('__companion__')).toBe(true)
      expect(m.seedsFromHistory('__wakeup__')).toBe(true) // 唤醒保留历史记忆辅助决策
      expect(m.seedsFromHistory('__watch__')).toBe(false) // 关切逐次失忆，避免串味
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

    it('watch 现状（policy.seedFromHistoryOnColdStart=false）：恒新起 session_，不回种', () => {
      // 桌面 watch 的真实路径：policy 设为 false（关切逐次失忆），即便未抑制也不回种。
      const m = mgr()
      m.conversationStore.save(rec('watch_w_old', { agentKey: '__watch__', timestamp: 1000 }))
      const fresh = mgr()
      const r = fresh.resolveSeedSessionId({ agentKey: '__watch__', suppressSeed: true })
      expect(r.sessionId).toMatch(/^session_\d+/)
      expect(r.sessionId).not.toBe('watch_w_old')
    })

    it('watch 即使未抑制也新起：policy=false 直接跳过回种分支', () => {
      // watch 的 seedFromHistoryOnColdStart 已改为 false（逐次失忆），不再进入回种分支。
      const m = mgr()
      m.conversationStore.save(rec('watch_w_seed', { agentKey: '__watch__', timestamp: 1000 }))
      const fresh = mgr()
      expect(fresh.resolveSeedSessionId({ agentKey: '__watch__' }).sessionId).toMatch(/^session_\d+/)
    })

    it('wakeup 现状（startNewSession→suppressSeed=true）：新起独立 session_，不回种', () => {
      // wakeup 真实路径：每次执行先 startNewSession 抑制回种，保持独立记录（但 TaskMemory 仍重建）。
      const m = mgr()
      m.conversationStore.save(rec('wakeup_w_old', { agentKey: '__wakeup__', timestamp: 1000 }))
      const fresh = mgr()
      const r = fresh.resolveSeedSessionId({ agentKey: '__wakeup__', suppressSeed: true })
      expect(r.sessionId).toMatch(/^session_\d+/)
      expect(r.sessionId).not.toBe('wakeup_w_old')
    })

    it('wakeup 即使未抑制也新起：其历史在独立 watch 树，latestByAgentKey（主树）查不到', () => {
      // 关键保真：wakeup 虽是持久命名 Agent（seedsFromHistory=true），但记录被路由到
      // 独立 watch 树，而回种用的 latestByAgentKey 只查主树 → 恒 undefined → 恒新起 session_。
      // 这正是 wakeup「逐次独立记录」在存储层的根因——但 TaskMemory 仍会跨执行重建。
      const m = mgr()
      m.conversationStore.save(rec('wakeup_w_seed', { agentKey: '__wakeup__', timestamp: 1000 }))
      const fresh = mgr()
      expect(fresh.latestByAgentKey('__wakeup__')).toBeUndefined()
      expect(fresh.resolveSeedSessionId({ agentKey: '__wakeup__' }).sessionId).toMatch(/^session_\d+/)
    })
  })

  describe('查询委托', () => {
    it('getRecord / latestByAgentKey / recent / listSummaries 透传 Store 语义', () => {
      const m = mgr()
      m.conversationStore.save(rec('sess_q1', { agentKey: 'tab-1', timestamp: Date.now() - 2000 }))
      m.conversationStore.save(rec('sess_q2', { agentKey: 'tab-1', timestamp: Date.now() }))
      m.conversationStore.save(rec('watch_q', { agentKey: '__watch__' }))
      m.conversationStore.save(rec('wakeup_q', { agentKey: '__wakeup__' }))

      const fresh = mgr()
      expect(fresh.getRecord('sess_q1')!.id).toBe('sess_q1')
      expect(fresh.latestByAgentKey('tab-1')!.id).toBe('sess_q2')
      // 任务侧栏口径不含 watch/wakeup
      expect(fresh.listSummaries(true).some(s => s.id === 'watch_q')).toBe(false)
      expect(fresh.listSummaries(true).some(s => s.id === 'wakeup_q')).toBe(false)
      // watch/wakeup 都进独立树
      expect(fresh.recentWatch(20).some(r => r.id === 'watch_q')).toBe(true)
      expect(fresh.recentWatch(20).some(r => r.id === 'wakeup_q')).toBe(true)
    })

    it('delete 透传', () => {
      const m = mgr()
      m.conversationStore.save(rec('sess_del'))
      expect(m.delete('sess_del')).toBe(true)
      expect(mgr().getRecord('sess_del')).toBeUndefined()
    })
  })

  describe('读侧权威：recentRecords / search 的任务侧栏过滤（封装旧 agentKey 字面量）', () => {
    function seedMixed(m: ConversationManager) {
      m.conversationStore.save(rec('sess_task', { agentKey: 'tab-1', userTask: '任务记录' }))
      m.conversationStore.save(rec('sess_comp', { agentKey: '__companion__', userTask: '联络记录' }))
      m.conversationStore.save(rec('watch_run_1', { agentKey: '__watch__', userTask: '关切记录' }))
      m.conversationStore.save(rec('wakeup_run_1', { agentKey: '__wakeup__', userTask: '唤醒记录' }))
    }

    it('recentRecords(excludeWakeup=false)：含 task + companion（不含独立树的 watch/wakeup）', () => {
      const m = mgr()
      seedMixed(m)
      const ids = mgr().recentRecords(50, false).map(r => r.id)
      expect(ids).toContain('sess_task')
      expect(ids).toContain('sess_comp')
      expect(ids).not.toContain('watch_run_1') // watch 在独立树
      expect(ids).not.toContain('wakeup_run_1') // wakeup 也在独立树
    })

    it('recentRecords(excludeWakeup=true)：任务侧栏口径，仅 task（剔除 companion + watch + wakeup）', () => {
      const m = mgr()
      seedMixed(m)
      const ids = mgr().recentRecords(50, true).map(r => r.id)
      expect(ids).toEqual(['sess_task'])
    })

    it('search(excludeWakeup=true)：companion/watch/wakeup 记录不进任务搜索结果', async () => {
      const m = mgr()
      seedMixed(m)
      const res = await mgr().search({ keyword: '记录', excludeWakeup: true })
      const ids = res.records.map(r => r.id)
      expect(ids).toContain('sess_task')
      expect(ids).not.toContain('sess_comp')
      expect(ids).not.toContain('watch_run_1')
      expect(ids).not.toContain('wakeup_run_1')
    })

    it('search(excludeWakeup=false)：companion 记录可被搜到', async () => {
      const m = mgr()
      seedMixed(m)
      const res = await mgr().search({ keyword: '联络', excludeWakeup: false })
      expect(res.records.some(r => r.id === 'sess_comp')).toBe(true)
    })

    it('byDateRange 透传：取完整记录', () => {
      const m = mgr()
      m.conversationStore.save(rec('sess_d1', { agentKey: 'tab-1' }))
      expect(mgr().byDateRange().some(r => r.id === 'sess_d1')).toBe(true)
    })
  })
})
