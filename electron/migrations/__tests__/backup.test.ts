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
  }
}))

import { createBackup } from '../backup'

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-backup-test-'))
})

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

describe('backup - 凭证文件纳入备份', () => {
  it('credentials.json 和 master.key 同时存在时都被备份', () => {
    // 模拟 v7 引入后的 userData 状态
    fs.writeFileSync(path.join(tmpDir, 'credentials.json'), '{"items":{}}', { mode: 0o600 })
    fs.writeFileSync(path.join(tmpDir, 'master.key'), Buffer.alloc(16), { mode: 0o600 })

    const backupPath = createBackup(tmpDir, 'test-cred')
    expect(backupPath).not.toBeNull()

    expect(fs.existsSync(path.join(backupPath!, 'credentials.json'))).toBe(true)
    expect(fs.existsSync(path.join(backupPath!, 'master.key'))).toBe(true)

    // 内容一致
    const origCred = fs.readFileSync(path.join(tmpDir, 'credentials.json'), 'utf-8')
    const bakCred = fs.readFileSync(path.join(backupPath!, 'credentials.json'), 'utf-8')
    expect(bakCred).toBe(origCred)
  })

  it('只有 credentials.json 没有 master.key 时也备份（best-effort，不阻塞）', () => {
    fs.writeFileSync(path.join(tmpDir, 'credentials.json'), '{"items":{"k":"g1:abc"}}', { mode: 0o600 })
    // 不创建 master.key

    const backupPath = createBackup(tmpDir, 'test-cred-partial')
    expect(backupPath).not.toBeNull()
    expect(fs.existsSync(path.join(backupPath!, 'credentials.json'))).toBe(true)
    expect(fs.existsSync(path.join(backupPath!, 'master.key'))).toBe(false)
  })

  it('都不存在时正常跳过，不报错', () => {
    const backupPath = createBackup(tmpDir, 'test-empty')
    // backup.ts 在所有 target 都不存在时会返回 null（"No data to backup"）
    expect(backupPath).toBeNull()
  })

  it('备份保留最近 5 份，超出清理', () => {
    fs.writeFileSync(path.join(tmpDir, 'credentials.json'), '{"items":{}}', { mode: 0o600 })
    // 创建 7 份备份
    for (let i = 0; i < 7; i++) {
      createBackup(tmpDir, `test-prune-${i}`)
      // 微调时间戳确保排序稳定（fs.mtime 精度可能不足）
      const now = Date.now() + i * 1000
      const bakDir = path.join(tmpDir, 'backups')
      if (fs.existsSync(bakDir)) {
        for (const name of fs.readdirSync(bakDir)) {
          if (name.startsWith(`test-prune-${i}`)) {
            const p = path.join(bakDir, name)
            fs.utimesSync(p, now, now)
          }
        }
      }
    }

    const backupsDir = path.join(tmpDir, 'backups')
    const remaining = fs.readdirSync(backupsDir).filter(n => n.startsWith('test-prune-'))
    expect(remaining.length).toBeLessThanOrEqual(5)
  })
})
