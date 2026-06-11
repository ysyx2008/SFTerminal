import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { AgentRecord } from '@shared/types'
import {
  AGENT_MIGRATED_SUFFIX,
  cleanupExpiredMigratedBackups,
  getAgentRecordPath,
  listLegacyAgentDayFiles,
  MIGRATED_RETENTION_MS,
} from '../history/agent-storage'
import { migrateLegacyAgentDayFiles } from '../../migrations/v5-agent-history-per-session'

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

function makeRecord(id: string, timestamp: number): AgentRecord {
  return {
    id,
    timestamp,
    duration: 100,
    userTask: `task ${id}`,
    terminalId: 'pty-1',
    terminalType: 'local',
    steps: [],
    status: 'completed',
  }
}

describe('agent history v5 migration', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-agent-migrate-'))
    fs.mkdirSync(path.join(tmpDir, 'history', 'agent'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('拆分旧日文件并保留 .migrated 备份', async () => {
    const agentDir = path.join(tmpDir, 'history', 'agent')
    const legacyPath = path.join(agentDir, '2026-03-18.json')
    fs.writeFileSync(legacyPath, JSON.stringify([
      makeRecord('r1', new Date('2026-03-18T10:00:00').getTime()),
      makeRecord('r2', new Date('2026-03-18T11:00:00').getTime()),
    ], null, 2))

    const progress: Array<{ pct: number; label: string }> = []
    const result = await migrateLegacyAgentDayFiles(tmpDir, async (pct, label) => {
      progress.push({ pct, label })
    })

    expect(result.migratedDays).toBe(1)
    expect(result.migratedRecords).toBe(2)
    expect(listLegacyAgentDayFiles(agentDir)).toEqual([])
    expect(fs.existsSync(path.join(agentDir, `2026-03-18${AGENT_MIGRATED_SUFFIX}`))).toBe(true)
    expect(fs.existsSync(getAgentRecordPath(agentDir, '2026-03-18', 'r1'))).toBe(true)
    expect(fs.existsSync(getAgentRecordPath(agentDir, '2026-03-18', 'r2'))).toBe(true)
    expect(progress.length).toBeGreaterThan(0)
  })

  it('cleanupExpiredMigratedBackups 仅删除超过 30 天的 .migrated', () => {
    const agentDir = path.join(tmpDir, 'history', 'agent')
    const oldBackup = path.join(agentDir, `2025-01-01${AGENT_MIGRATED_SUFFIX}`)
    const recentBackup = path.join(agentDir, `2026-03-01${AGENT_MIGRATED_SUFFIX}`)
    fs.writeFileSync(oldBackup, '[]')
    fs.writeFileSync(recentBackup, '[]')

    const oldTime = Date.now() - MIGRATED_RETENTION_MS - 1000
    const recentTime = Date.now() - 1000
    fs.utimesSync(oldBackup, oldTime / 1000, oldTime / 1000)
    fs.utimesSync(recentBackup, recentTime / 1000, recentTime / 1000)

    const removed = cleanupExpiredMigratedBackups(agentDir)
    expect(removed).toBe(1)
    expect(fs.existsSync(oldBackup)).toBe(false)
    expect(fs.existsSync(recentBackup)).toBe(true)
  })

  it('deleteAgentRecord 可从旧日文件中删除记录', () => {
    const agentDir = path.join(tmpDir, 'history', 'agent')
    const baseTime = new Date('2026-03-18T10:00:00').getTime()
    fs.writeFileSync(path.join(agentDir, '2026-03-18.json'), JSON.stringify([
      makeRecord('legacy-keep', baseTime),
      makeRecord('legacy-remove', baseTime + 1000),
    ], null, 2))

    const svc = new HistoryService()
    expect(svc.deleteAgentRecord('legacy-remove')).toBe(true)
    expect(svc.getAgentRecordById('legacy-remove')).toBeUndefined()
    expect(svc.getAgentRecordById('legacy-keep')?.id).toBe('legacy-keep')

    const remaining = JSON.parse(fs.readFileSync(path.join(agentDir, '2026-03-18.json'), 'utf-8'))
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe('legacy-keep')
  })

  it('HistoryService 仍可读取未迁移的旧日文件', () => {
    const agentDir = path.join(tmpDir, 'history', 'agent')
    fs.writeFileSync(path.join(agentDir, '2026-03-18.json'), JSON.stringify([
      makeRecord('legacy-1', new Date('2026-03-18T10:00:00').getTime()),
    ], null, 2))

    const svc = new HistoryService()
    const record = svc.getAgentRecordById('legacy-1')
    expect(record?.id).toBe('legacy-1')
  })

  it('getStorageStats 的 agentFiles 统计有记录的天数而非会话文件数', async () => {
    const agentDir = path.join(tmpDir, 'history', 'agent')
    fs.writeFileSync(path.join(agentDir, '2026-03-18.json'), JSON.stringify([
      makeRecord('legacy-1', new Date('2026-03-18T10:00:00').getTime()),
      makeRecord('legacy-2', new Date('2026-03-18T11:00:00').getTime()),
    ], null, 2))

    await migrateLegacyAgentDayFiles(tmpDir, async () => {})

    const svc = new HistoryService()
    const stats = svc.getStorageStats()
    expect(stats.agentFiles).toBe(1)
    expect(stats.oldestRecord).toBe('2026-03-18')
    expect(stats.newestRecord).toBe('2026-03-18')
  })
})
