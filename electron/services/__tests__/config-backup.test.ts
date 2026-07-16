import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return tmpDir
      return tmpDir
    },
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false,
  },
}))

import {
  MAIN_CONFIG_FILENAME,
  createConfigBackup,
  pruneConfigBackups,
  tryRestoreConfigFromBackups,
  isRestorableConfigSnapshot,
  setConfigBackupUserDataForTest,
  MAX_RECENT_SNAPSHOTS,
  getConfigBackupsRoot,
  setConfigRecoveryNotice,
  peekConfigRecoveryNotice,
  dismissConfigRecoveryNotice,
} from '../config-backup'

function writeMainConfig(userData: string, data: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(userData, MAIN_CONFIG_FILENAME),
    JSON.stringify(data),
    'utf-8'
  )
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-config-backup-'))
  setConfigBackupUserDataForTest(tmpDir)
})

afterEach(() => {
  setConfigBackupUserDataForTest(null)
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

describe('config-backup', () => {
  it('createConfigBackup 写入可恢复快照', () => {
    writeMainConfig(tmpDir, { aiProfiles: [{ id: '1' }], theme: 'one-dark' })
    fs.writeFileSync(path.join(tmpDir, 'credentials.json'), JSON.stringify({}), 'utf-8')
    fs.writeFileSync(path.join(tmpDir, 'master.key'), 'not-empty-key', 'utf-8')

    const dir = createConfigBackup(tmpDir, { force: true })
    expect(dir).toBeTruthy()
    expect(isRestorableConfigSnapshot(dir!)).toBe(true)
    expect(fs.existsSync(path.join(dir!, MAIN_CONFIG_FILENAME))).toBe(true)
    expect(fs.existsSync(path.join(dir!, 'manifest.json'))).toBe(true)
  })

  it('相同内容不重复建快照（hash 去重）', () => {
    writeMainConfig(tmpDir, { aiProfiles: [] })
    const a = createConfigBackup(tmpDir, { force: true })
    expect(a).toBeTruthy()
    const b = createConfigBackup(tmpDir)
    expect(b).toBeNull()
  })

  it('prune 保留近期槽上限内的快照', () => {
    writeMainConfig(tmpDir, { v: 0 })
    const root = getConfigBackupsRoot(tmpDir)
    fs.mkdirSync(root, { recursive: true })

    // 手工塞入超过上限的快照目录（跳过真实 create 的 debounce/hash）
    const now = Date.now()
    for (let i = 0; i < MAX_RECENT_SNAPSHOTS + 5; i++) {
      const name = `snap-${String(i).padStart(3, '0')}`
      const dir = path.join(root, name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, MAIN_CONFIG_FILENAME),
        JSON.stringify({ i }),
        'utf-8'
      )
      const t = now - i * 1000
      fs.utimesSync(dir, new Date(t), new Date(t))
    }

    pruneConfigBackups(root)
    const left = fs.readdirSync(root).filter((n) => !n.startsWith('.'))
    expect(left.length).toBeLessThanOrEqual(MAX_RECENT_SNAPSHOTS + 1) // 日保底可能多留当天最早
  })

  it('主配置损坏时可从最新合法快照恢复', () => {
    writeMainConfig(tmpDir, { aiProfiles: [{ id: 'keep-me' }], activeAiProfile: 'keep-me' })
    const snap = createConfigBackup(tmpDir, { force: true })
    expect(snap).toBeTruthy()

    fs.writeFileSync(path.join(tmpDir, MAIN_CONFIG_FILENAME), '{broken', 'utf-8')
    const from = tryRestoreConfigFromBackups(tmpDir)
    expect(from).toBe(snap)

    const restored = JSON.parse(
      fs.readFileSync(path.join(tmpDir, MAIN_CONFIG_FILENAME), 'utf-8')
    )
    expect(restored.aiProfiles[0].id).toBe('keep-me')
  })

  it('无可用备份时 tryRestore 返回 null', () => {
    writeMainConfig(tmpDir, { aiProfiles: [] })
    fs.writeFileSync(path.join(tmpDir, MAIN_CONFIG_FILENAME), 'not-json', 'utf-8')
    expect(tryRestoreConfigFromBackups(tmpDir)).toBeNull()
  })

  it('非法主配置不会进入滚动备份', () => {
    fs.writeFileSync(path.join(tmpDir, MAIN_CONFIG_FILENAME), '[1,2,3]', 'utf-8')
    expect(createConfigBackup(tmpDir, { force: true })).toBeNull()
  })

  it('recovery notice 可 peek / dismiss 并落盘', () => {
    setConfigRecoveryNotice({ kind: 'reset', at: 123 })
    expect(peekConfigRecoveryNotice()?.kind).toBe('reset')
    expect(fs.existsSync(path.join(tmpDir, 'config-recovery-notice.json'))).toBe(true)
    dismissConfigRecoveryNotice()
    expect(peekConfigRecoveryNotice()).toBeNull()
    expect(fs.existsSync(path.join(tmpDir, 'config-recovery-notice.json'))).toBe(false)
  })
})
