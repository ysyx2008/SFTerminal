import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// migration 模块顶层 import 了 migration-progress（依赖 electron BrowserWindow），需 mock
vi.mock('electron', () => ({
  app: { getPath: () => '', getName: () => 'SailFish', getVersion: () => '1.0.0', isPackaged: false },
  BrowserWindow: class {},
}))

import { splitWatchHistory } from '../v6-watch-history-split'

let tmpDir: string

function writeAgentFile(userDataPath: string, dateStr: string, record: Record<string, unknown>) {
  const dir = path.join(userDataPath, 'history', 'agent', dateStr)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2))
}

function baseRecord(id: string, userTask: string, agentKey?: string) {
  return {
    id, sessionId: id, timestamp: new Date('2026-03-18T10:00:00').getTime(),
    duration: 1, userTask, terminalId: '', terminalType: 'assistant',
    steps: [], status: 'completed', agentKey,
  }
}

describe('migration v6 - splitWatchHistory', () => {
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-v6-test-')) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('把 watch 记录（新 agentKey + 老启发式）rename 到 watch 树，用户任务留在原地', async () => {
    writeAgentFile(tmpDir, '2026-03-18', baseRecord('user-1', '部署 nginx'))
    writeAgentFile(tmpDir, '2026-03-18', baseRecord('watch-new', '心跳', '__watch__'))
    // 老记录：无 agentKey，靠 userTask 心跳前缀识别
    writeAgentFile(tmpDir, '2026-03-18', baseRecord('watch-old', '[当前时间：2026-03-18] 触发事件：定时'))

    const result = await splitWatchHistory(tmpDir)

    expect(result.scanned).toBe(3)
    expect(result.moved).toBe(2)

    const agentDir = path.join(tmpDir, 'history', 'agent', '2026-03-18')
    const watchDir = path.join(tmpDir, 'history', 'watch', '2026-03-18')

    // 用户任务原地不动
    expect(fs.existsSync(path.join(agentDir, 'user-1.json'))).toBe(true)
    // watch 记录搬到 watch 树
    expect(fs.existsSync(path.join(watchDir, 'watch-new.json'))).toBe(true)
    expect(fs.existsSync(path.join(watchDir, 'watch-old.json'))).toBe(true)
    expect(fs.existsSync(path.join(agentDir, 'watch-new.json'))).toBe(false)
    expect(fs.existsSync(path.join(agentDir, 'watch-old.json'))).toBe(false)

    // 正文内容逐字节不变（rename，非重写）
    const moved = JSON.parse(fs.readFileSync(path.join(watchDir, 'watch-old.json'), 'utf-8'))
    expect(moved.userTask).toBe('[当前时间：2026-03-18] 触发事件：定时')
  })

  it('无 agent 历史目录时安全跳过', async () => {
    const result = await splitWatchHistory(tmpDir)
    expect(result).toEqual({ moved: 0, scanned: 0, errors: [] })
  })

  it('空 agent 日期目录在迁移后被清理', async () => {
    writeAgentFile(tmpDir, '2026-03-18', baseRecord('watch-only', '心跳', '__watch__'))
    await splitWatchHistory(tmpDir)
    expect(fs.existsSync(path.join(tmpDir, 'history', 'agent', '2026-03-18'))).toBe(false)
  })
})
