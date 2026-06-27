/**
 * ConversationStore 单测：验证它作为「HistoryService 之上的薄存储接缝」的委托正确性。
 *
 * 重点不是重测 HistoryService（那有自己的测试），而是钉住接缝契约：
 * - save/load/delete 走真实磁盘往返、会话粒度（同 id 覆盖）
 * - main/watch 路由由 agentKey 自动完成（__watch__ 进独立树，不污染主历史）
 * - latestByAgentKey / recent / listSummaries 透传 HistoryService 的语义
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
    messages: [
      { role: 'user', content: `问题 ${id}` },
      { role: 'assistant', content: `回答 ${id}` }
    ],
    duration: 0,
    status: 'completed',
    ...overrides
  } as AgentRecord
}

describe('ConversationStore（HistoryService 之上的薄存储接缝）', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-conv-store-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('save/load：真实磁盘往返，按 id 精确读回', () => {
    const store = new ConversationStore(new HistoryService().getAgentRecordStore())
    store.save(rec('sess_a'))

    // 换一个 HistoryService 实例读（强制走盘，不吃内存缓存）
    const loaded = new ConversationStore(new HistoryService().getAgentRecordStore()).load('sess_a')
    expect(loaded).toBeTruthy()
    expect(loaded!.id).toBe('sess_a')
    expect(loaded!.userTask).toBe('任务 sess_a')
    expect((loaded!.messages as any[]).length).toBe(2)
  })

  it('save 会话粒度：同 id 覆盖、不新增', () => {
    const store = new ConversationStore(new HistoryService().getAgentRecordStore())
    store.save(rec('sess_dup', { userTask: '旧标题' }))
    store.save(rec('sess_dup', { userTask: '新标题' }))

    const fresh = new ConversationStore(new HistoryService().getAgentRecordStore())
    const matches = fresh.recent(50).filter(r => r.id === 'sess_dup')
    expect(matches.length).toBe(1)
    expect(matches[0].userTask).toBe('新标题')
  })

  it('delete：删除后读不到', () => {
    const store = new ConversationStore(new HistoryService().getAgentRecordStore())
    store.save(rec('sess_del'))
    expect(store.delete('sess_del')).toBe(true)
    expect(new ConversationStore(new HistoryService().getAgentRecordStore()).load('sess_del')).toBeUndefined()
  })

  it('main/watch 路由：__watch__ 进独立树，不污染主历史/任务侧栏', () => {
    const store = new ConversationStore(new HistoryService().getAgentRecordStore())
    store.save(rec('sess_task', { agentKey: 'tab-1' }))
    store.save(rec('watch_w1_123', { agentKey: '__watch__' }))

    const fresh = new ConversationStore(new HistoryService().getAgentRecordStore())
    // watch 记录进 watch 树
    expect(fresh.recentWatch(20).some(r => r.id === 'watch_w1_123')).toBe(true)
    // 不进主历史
    expect(fresh.recent(20).some(r => r.id === 'watch_w1_123')).toBe(false)
    // 任务侧栏（excludeWakeup）也不含 watch
    const summaries = fresh.listSummaries(true)
    expect(summaries.some(s => s.id === 'watch_w1_123')).toBe(false)
    expect(summaries.some(s => s.id === 'sess_task')).toBe(true)
  })

  it('latestByAgentKey / recentByAgentKey：按 agentKey 取最近会话', () => {
    const store = new ConversationStore(new HistoryService().getAgentRecordStore())
    store.save(rec('sess_c1', { agentKey: '__companion__', timestamp: Date.now() - 2000 }))
    store.save(rec('sess_c2', { agentKey: '__companion__', timestamp: Date.now() }))

    const fresh = new ConversationStore(new HistoryService().getAgentRecordStore())
    expect(fresh.latestByAgentKey('__companion__')!.id).toBe('sess_c2')
    const recent = fresh.recentByAgentKey('__companion__', 10)
    expect(recent.map(r => r.id).sort()).toEqual(['sess_c1', 'sess_c2'])
  })
})
