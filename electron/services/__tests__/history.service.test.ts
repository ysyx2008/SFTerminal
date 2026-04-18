import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { AgentRecord } from '@shared/types'

let tmpDir: string

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false
  }
}))

import { HistoryService } from '../history.service'

function makeRecord(overrides: Partial<AgentRecord> & { id: string; timestamp: number; duration: number; userTask: string }): AgentRecord {
  return {
    terminalId: 'pty-1',
    terminalType: 'local',
    steps: [],
    status: 'completed',
    ...overrides,
  }
}

describe('HistoryService - getRecentAgentRecords', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-history-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('按最后更新时间（timestamp + duration）排序', () => {
    const svc = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()

    // A: lastUpdated = 11:00
    svc.saveAgentRecord(makeRecord({
      id: 'a', timestamp: baseTime, duration: 3600_000, userTask: 'task A'
    }))
    // B: lastUpdated = 10:40
    svc.saveAgentRecord(makeRecord({
      id: 'b', timestamp: baseTime + 1800_000, duration: 600_000, userTask: 'task B'
    }))
    // C: lastUpdated = 12:00（最老开始但最后更新最晚）
    svc.saveAgentRecord(makeRecord({
      id: 'c', timestamp: baseTime - 3600_000, duration: 10800_000, userTask: 'task C'
    }))

    const results = svc.getRecentAgentRecords(3)
    expect(results.map(r => r.id)).toEqual(['c', 'a', 'b'])
  })

  it('跨天更新的对话不被遗漏', () => {
    const svc = new HistoryService()
    const day1 = new Date('2026-03-10T14:00:00').getTime()
    const day2 = new Date('2026-03-17T09:00:00').getTime()
    const day3 = new Date('2026-03-18T10:00:00').getTime()

    // 3月10号开始，持续 9 天 → lastUpdated ≈ 3月19号
    svc.saveAgentRecord(makeRecord({
      id: 'old-but-active', timestamp: day1, duration: 9 * 86400_000, userTask: 'long session'
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'mid', timestamp: day2, duration: 3600_000, userTask: 'mid session'
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'recent', timestamp: day3, duration: 600_000, userTask: 'recent session'
    }))

    const results = svc.getRecentAgentRecords(3)
    expect(results[0].id).toBe('old-but-active')
    expect(results.map(r => r.id)).toEqual(['old-but-active', 'recent', 'mid'])
  })

  it('filter 在索引条目上正确工作', () => {
    const svc = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({
      id: 'normal', timestamp: baseTime, duration: 100, userTask: '正常任务'
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'wakeup', timestamp: baseTime + 1000, duration: 200,
      userTask: '[当前时间：2026-03-18] 触发事件：定时'
    }))

    const filter = (r: AgentRecord) =>
      !(r.userTask.startsWith('[当前时间：') && r.userTask.includes('触发事件'))

    const results = svc.getRecentAgentRecords(10, filter)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('normal')
  })

  it('索引不存在时自动从日期文件重建', () => {
    const svc1 = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()

    svc1.saveAgentRecord(makeRecord({
      id: 'r1', timestamp: baseTime, duration: 1000, userTask: 'task 1'
    }))
    svc1.saveAgentRecord(makeRecord({
      id: 'r2', timestamp: baseTime + 5000, duration: 500, userTask: 'task 2'
    }))

    // 删除索引文件，模拟老版本升级
    const indexPath = path.join(tmpDir, 'history', 'agent-index.json')
    expect(fs.existsSync(indexPath)).toBe(true)
    fs.unlinkSync(indexPath)

    // 新实例（_indexCache 为 null）应自动重建
    const svc2 = new HistoryService()
    const results = svc2.getRecentAgentRecords(10)
    expect(results).toHaveLength(2)
    expect(fs.existsSync(indexPath)).toBe(true)
  })

  it('更新已有记录时索引同步更新、无重复', () => {
    const svc = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({
      id: 'r1', timestamp: baseTime, duration: 1000, userTask: 'task 1'
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'r2', timestamp: baseTime + 5000, duration: 500, userTask: 'task 2'
    }))

    // 更新 r1：duration 大增，应排到第一
    svc.saveAgentRecord(makeRecord({
      id: 'r1', timestamp: baseTime, duration: 100_000, userTask: 'task 1 updated'
    }))

    const results = svc.getRecentAgentRecords(2)
    expect(results[0].id).toBe('r1')
    expect(results[0].userTask).toBe('task 1 updated')

    const indexContent = JSON.parse(fs.readFileSync(
      path.join(tmpDir, 'history', 'agent-index.json'), 'utf-8'
    ))
    expect(indexContent).toHaveLength(2)
  })

  it('cleanupOldRecords 后索引同步重建', () => {
    const svc = new HistoryService()
    const oldTime = new Date('2025-01-01T10:00:00').getTime()
    // 用相对当前时间的日期，避免硬编码日期随时间流逝变"旧"
    const recentTime = Date.now() - 24 * 60 * 60 * 1000 // 1 天前

    svc.saveAgentRecord(makeRecord({
      id: 'old', timestamp: oldTime, duration: 100, userTask: 'old task'
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'new', timestamp: recentTime, duration: 100, userTask: 'new task'
    }))

    expect(svc.getRecentAgentRecords(10)).toHaveLength(2)

    svc.cleanupOldRecords(30)

    const results = svc.getRecentAgentRecords(10)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('new')
  })

  it('无记录时返回空数组', () => {
    const svc = new HistoryService()
    expect(svc.getRecentAgentRecords(5)).toEqual([])
  })

  it('limit 小于总记录数时只返回 top N', () => {
    const svc = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()

    for (let i = 0; i < 10; i++) {
      svc.saveAgentRecord(makeRecord({
        id: `r${i}`, timestamp: baseTime + i * 1000, duration: i * 100, userTask: `task ${i}`
      }))
    }

    const results = svc.getRecentAgentRecords(3)
    expect(results).toHaveLength(3)
  })
})
