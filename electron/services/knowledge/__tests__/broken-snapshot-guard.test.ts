import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const tmpDir = path.join(os.tmpdir(), `sailfish-broken-snapshot-${process.pid}`)

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpDir }
}))

const {
  createBackup,
  restoreBackup,
  listBackups,
  listBrokenSnapshots,
  markRestoreExhausted,
  isRestoreExhausted,
  clearRestoreExhausted,
  adoptLegacyBrokenSnapshots,
  MAX_BROKEN_SNAPSHOTS,
} = await import('../backup')

function knowledgeDir(): string {
  return path.join(tmpDir, 'knowledge')
}

function writeKnowledge(label: string): void {
  const dir = knowledgeDir()
  fs.mkdirSync(path.join(dir, 'lancedb'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'documents.json'), JSON.stringify({ label }))
}

function labelOf(dir: string): string {
  return JSON.parse(fs.readFileSync(path.join(dir, 'documents.json'), 'utf-8')).label
}

describe('救不回来的时候，别把磁盘吃掉', () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.mkdirSync(tmpDir, { recursive: true })
    writeKnowledge('current')
  })

  it('现场集中放在一处，不再散落在数据目录根下', () => {
    const backup = createBackup(false)
    writeKnowledge('broken')

    restoreBackup(backup.backupPath)

    expect(listBrokenSnapshots()).toHaveLength(1)
    const strays = fs.readdirSync(tmpDir).filter(n => n.startsWith('knowledge.broken-'))
    expect(strays).toEqual([])
  })

  it('同一轮里试更早的备份时，被换下来的副本不当现场留着', () => {
    const backup = createBackup(false)

    writeKnowledge('user-data-gone-bad')
    restoreBackup(backup.backupPath)                              // 第一次：留现场
    restoreBackup(backup.backupPath, { keepSnapshot: false })     // 再试一份：不留
    restoreBackup(backup.backupPath, { keepSnapshot: false })

    const snapshots = listBrokenSnapshots()
    expect(snapshots).toHaveLength(1)
    // 留下的必须是用户数据坏掉的那个样子，不是备份的副本
    expect(labelOf(snapshots[0].path)).toBe('user-data-gone-bad')
  })

  it('现场有上限，反复启动不会越堆越多', () => {
    const backup = createBackup(false)

    for (let i = 0; i < MAX_BROKEN_SNAPSHOTS + 3; i++) {
      writeKnowledge(`broken-${i}`)
      restoreBackup(backup.backupPath)
    }

    const snapshots = listBrokenSnapshots()
    expect(snapshots).toHaveLength(MAX_BROKEN_SNAPSHOTS)
    // 留下的是最近几份
    const labels = snapshots.map(s => labelOf(s.path)).sort()
    expect(labels).toEqual(['broken-3', 'broken-4'])
  })

  it('同一毫秒内连着留现场也不会撞名把恢复带崩', () => {
    const backup = createBackup(false)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    try {
      for (let i = 0; i < 3; i++) {
        writeKnowledge(`same-ms-${i}`)
        const result = restoreBackup(backup.backupPath)
        expect(result.success).toBe(true)
      }
    } finally {
      vi.restoreAllMocks()
    }

    expect(listBrokenSnapshots()).toHaveLength(MAX_BROKEN_SNAPSHOTS)
  })

  it('这批备份都救不回来的结论会记住，下次不必重来', () => {
    createBackup(false)
    expect(isRestoreExhausted()).toBe(false)

    markRestoreExhausted()

    expect(isRestoreExhausted()).toBe(true)
  })

  it('备份有更新时结论作废，重新给机会', () => {
    createBackup(false)
    markRestoreExhausted()
    expect(isRestoreExhausted()).toBe(true)

    // 又多了一份备份（自动备份名按毫秒取，测试里得显式造一份避免撞名）
    const extra = path.join(tmpDir, 'knowledge-backups', 'manual-later')
    fs.mkdirSync(extra, { recursive: true })
    fs.writeFileSync(path.join(extra, 'documents.json'), JSON.stringify({ label: 'newer' }))

    expect(listBackups().length).toBe(2)
    expect(isRestoreExhausted()).toBe(false)
  })

  it('用户手动发起恢复时结论作废', () => {
    createBackup(false)
    markRestoreExhausted()

    clearRestoreExhausted()

    expect(isRestoreExhausted()).toBe(false)
  })

  it('老版本散落在数据目录根下的现场会被收编并轮转掉', () => {
    for (let i = 0; i < 5; i++) {
      const legacy = path.join(tmpDir, `knowledge.broken-${1000 + i}`)
      fs.mkdirSync(legacy, { recursive: true })
      fs.writeFileSync(path.join(legacy, 'documents.json'), JSON.stringify({ label: `legacy-${i}` }))
    }

    adoptLegacyBrokenSnapshots()

    expect(fs.readdirSync(tmpDir).filter(n => n.startsWith('knowledge.broken-'))).toEqual([])
    expect(listBrokenSnapshots()).toHaveLength(MAX_BROKEN_SNAPSHOTS)
  })

  it('没有遗留现场时收编是空操作，不建多余目录', () => {
    adoptLegacyBrokenSnapshots()

    expect(fs.existsSync(path.join(tmpDir, 'knowledge-broken'))).toBe(false)
  })

  it('没有任何备份时不会误判成「已经试过了」', () => {
    expect(listBackups()).toHaveLength(0)
    expect(isRestoreExhausted()).toBe(false)
  })
})
