import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const tmpDir = path.join(os.tmpdir(), `sailfish-backup-guard-${process.pid}`)

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpDir }
}))

const {
  createBackup,
  saveBackupTo,
  resolveKnowledgeSnapshot,
  hasCorruptionMarker,
  listBackups,
  restoreBackup
} = await import('../backup')

function knowledgeDir(): string {
  return path.join(tmpDir, 'knowledge')
}

function writeKnowledge(label: string): void {
  const dir = knowledgeDir()
  fs.mkdirSync(path.join(dir, 'lancedb'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'documents.json'), JSON.stringify({ label }))
  fs.writeFileSync(path.join(dir, 'lancedb', 'ok.txt'), label)
}

function markCorrupted(): void {
  fs.mkdirSync(path.join(knowledgeDir(), 'lancedb'), { recursive: true })
  fs.writeFileSync(
    path.join(knowledgeDir(), 'lancedb', '.corrupted'),
    JSON.stringify({ reason: 'test', at: Date.now() })
  )
}

describe('知识库损坏时不得把坏库存成最新备份', () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.mkdirSync(tmpDir, { recursive: true })
    writeKnowledge('current')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('已标损坏时自动备份直接跳过', () => {
    markCorrupted()
    expect(hasCorruptionMarker()).toBe(true)

    const result = createBackup(true)

    expect(result.success).toBe(true)
    expect(result.backupPath).toBeUndefined()
    expect(listBackups()).toHaveLength(0)
  })

  it('没有损坏标记时自动备份会落盘', () => {
    const result = createBackup(true)

    expect(result.success).toBe(true)
    expect(result.backupPath).toBeTruthy()
    expect(listBackups()).toHaveLength(1)
    expect(hasCorruptionMarker()).toBe(false)
  })

  it('可以从指定的更早备份恢复', () => {
    const newer = createBackup(false)
    writeKnowledge('older-source')
    const older = createBackup(false)
    writeKnowledge('broken')
    markCorrupted()

    const restored = restoreBackup(older.backupPath)

    expect(restored.success).toBe(true)
    expect(restored.backupPath).toBe(older.backupPath)
    const docs = JSON.parse(fs.readFileSync(path.join(knowledgeDir(), 'documents.json'), 'utf-8'))
    expect(docs.label).toBe('older-source')
    expect(newer.backupPath).toBeTruthy()
  })
})

describe('存到别处与从文件夹恢复是同一份快照', () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.mkdirSync(tmpDir, { recursive: true })
    writeKnowledge('portable')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('存到别处写出完整快照，且不进本机备份列表', () => {
    const dest = path.join(tmpDir, 'elsewhere')
    fs.mkdirSync(dest)

    const result = saveBackupTo(dest)

    expect(result.success).toBe(true)
    expect(result.backupPath).toBeTruthy()
    expect(fs.existsSync(path.join(result.backupPath!, 'documents.json'))).toBe(true)
    expect(listBackups()).toHaveLength(0)
  })

  it('选中外层目录时能认出里面仅有的一份快照', () => {
    const dest = path.join(tmpDir, 'elsewhere')
    fs.mkdirSync(dest)
    const saved = saveBackupTo(dest)

    expect(resolveKnowledgeSnapshot(dest)).toBe(saved.backupPath)
    expect(resolveKnowledgeSnapshot(saved.backupPath!)).toBe(saved.backupPath)
    expect(resolveKnowledgeSnapshot(path.join(tmpDir, 'empty-or-missing'))).toBeNull()
  })

  it('可以从存到别处的那份盖回来', () => {
    const dest = path.join(tmpDir, 'elsewhere')
    fs.mkdirSync(dest)
    const saved = saveBackupTo(dest)
    writeKnowledge('changed')

    const restored = restoreBackup(saved.backupPath)

    expect(restored.success).toBe(true)
    const docs = JSON.parse(fs.readFileSync(path.join(knowledgeDir(), 'documents.json'), 'utf-8'))
    expect(docs.label).toBe('portable')
  })
})
