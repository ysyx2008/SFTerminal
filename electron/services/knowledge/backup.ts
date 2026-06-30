/**
 * 知识库数据备份 / 恢复
 *
 * 用途：dev 热重载频繁触发 LanceDB 损坏 → 全量重建太慢。改成「损坏前已有快照，
 * 启动检测到损坏时先从备份恢复，恢复后跑 repairIndex() 增量补差集」，
 * 把"几十分钟全量重 embed"压成"几秒拷贝 + 几分钟补缺失文档"。
 *
 * 备份范围：整个 `{userData}/knowledge/` 目录
 *   - lancedb/             向量数据（最大头）
 *   - bm25-index.json      BM25 索引
 *   - bm25-index.json.tmp  原子写临时文件（恢复时优先尝试）
 *   - documents.json       文档元数据（真相源）
 *   - .password            加密口令（如有）
 *
 * 备份时机（关键）：
 *   - 仅在 disposeAsync 完成、worker 已 compact 落盘后做文件级复制——
 *     这是运行期唯一的「LanceDB 无写入」安全窗口
 *   - 距上次自动备份 > MIN_BACKUP_INTERVAL_MS 才备份，避免 dev 频繁热重载
 *     时每次都复制几十 MB
 *   - 手动备份不受时间间隔限制
 *
 * 恢复时机：
 *   - worker initialize 检测到 .corrupted 标记 / 维度不匹配时，先尝试从最近
 *     备份恢复；恢复成功就不发 dataCorrupted / dimensionMismatch 事件，
 *     后续由 KnowledgeService.checkAndRebuildIndex 跑增量补差集
 *   - 恢复失败再走原来的清表重建路径
 *
 * 轮转：保留最近 MAX_BACKUPS 份，按 mtime 排序删旧
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { createLogger } from '../../utils/logger'

const log = createLogger('KnowledgeBackup')

/** 自动备份的最小间隔（30 分钟）—— 防止 dev 热重载时每次都复制 */
export const MIN_BACKUP_INTERVAL_MS = 30 * 60 * 1000

/** 保留的自动备份数量 */
export const MAX_BACKUPS = 3

/** 备份根目录 */
function getBackupsRoot(): string {
  return path.join(app.getPath('userData'), 'knowledge-backups')
}

/** 知识库数据目录 */
function getKnowledgeDir(): string {
  return path.join(app.getPath('userData'), 'knowledge')
}

/** 上次自动备份时间戳文件 */
function getLastBackupMarkerPath(): string {
  return path.join(getBackupsRoot(), '.last-auto-backup')
}

/**
 * 递归复制目录（跳过符号链接，避免环）
 *
 * 跳过 .corrupted 标记文件：避免备份时把损坏标记一起带进备份，
 * 否则恢复后下次启动会再次触发恢复逻辑（虽不死循环，但无意义）。
 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    if (entry.name === '.corrupted') continue
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

/**
 * 递归删除目录（容错）
 */
function rmrfSync(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch (e) {
    log.warn(`rmrf 失败: ${target}`, e)
  }
}

export interface BackupEntry {
  /** 备份目录名（时间戳格式） */
  name: string
  /** 完整路径 */
  path: string
  /** 创建时间（ms） */
  createdAt: number
  /** 估算大小（字节） */
  sizeBytes: number
  /** 是否自动备份（带 auto- 前缀） */
  automatic: boolean
}

export interface CreateBackupResult {
  success: boolean
  backupPath?: string
  error?: string
}

export interface RestoreBackupResult {
  success: boolean
  backupPath?: string
  error?: string
}

/**
 * 列出所有备份，按时间倒序
 */
export function listBackups(): BackupEntry[] {
  const root = getBackupsRoot()
  if (!fs.existsSync(root)) return []

  const entries: BackupEntry[] = []
  for (const name of fs.readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue
    if (name.name.startsWith('.')) continue
    const fullPath = path.join(root, name.name)
    try {
      const stat = fs.statSync(fullPath)
      entries.push({
        name: name.name,
        path: fullPath,
        createdAt: stat.mtimeMs,
        sizeBytes: computeDirSize(fullPath),
        automatic: name.name.startsWith('auto-'),
      })
    } catch (e) {
      log.warn(`跳过无法读取的备份目录: ${name.name}`, e)
    }
  }

  entries.sort((a, b) => b.createdAt - a.createdAt)
  return entries
}

function computeDirSize(dir: string): number {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        total += computeDirSize(p)
      } else if (entry.isFile()) {
        total += fs.statSync(p).size
      }
    }
  } catch { /* ignore */ }
  return total
}

/**
 * 创建一份备份
 *
 * @param automatic true=自动备份（受 MIN_BACKUP_INTERVAL_MS 限制，前缀 auto-）
 *                  false=手动备份（不受限制，前缀 manual-）
 */
export function createBackup(automatic: boolean = true): CreateBackupResult {
  const knowledgeDir = getKnowledgeDir()
  const root = getBackupsRoot()

  if (!fs.existsSync(knowledgeDir)) {
    return { success: false, error: '知识库目录不存在，无可备份内容' }
  }

  // 自动备份时间间隔检查
  if (automatic) {
    if (fs.existsSync(getLastBackupMarkerPath())) {
      try {
        const last = parseInt(
          fs.readFileSync(getLastBackupMarkerPath(), 'utf-8').trim(),
          10
        )
        if (Date.now() - last < MIN_BACKUP_INTERVAL_MS) {
          log.info(`自动备份跳过：距上次备份 ${Math.round((Date.now() - last) / 1000)}s < ${MIN_BACKUP_INTERVAL_MS / 1000}s`)
          return { success: true, backupPath: undefined }
        }
      } catch { /* marker 损坏，继续备份 */ }
    }
  }

  fs.mkdirSync(root, { recursive: true })

  const prefix = automatic ? 'auto-' : 'manual-'
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(root, `${prefix}${timestamp}`)

  try {
    fs.mkdirSync(backupDir, { recursive: true })
    copyDirSync(knowledgeDir, backupDir)

    if (automatic) {
      fs.writeFileSync(getLastBackupMarkerPath(), String(Date.now()), 'utf-8')
    }

    log.info(`备份完成: ${backupDir}`)
    pruneOldBackups()

    return { success: true, backupPath: backupDir }
  } catch (e) {
    log.error('备份失败:', e)
    // 备份失败时清理半成品目录
    rmrfSync(backupDir)
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * 轮转：保留最近 MAX_BACKUPS 份自动备份。
 * 手动备份不参与自动轮转（用户主动建的，不应被悄悄删）。
 */
function pruneOldBackups(): void {
  const backups = listBackups()
  const autoBackups = backups.filter(b => b.automatic)
  const manualBackups = backups.filter(b => !b.automatic)

  for (const old of autoBackups.slice(MAX_BACKUPS)) {
    rmrfSync(old.path)
    log.info(`已轮转删除旧自动备份: ${old.name}`)
  }
}

/**
 * 从指定备份恢复。
 * 恢复策略：先把当前 knowledge/ 改名为 knowledge.broken-{ts}/（保留现场便于排查），
 * 再把备份复制回去。这样即便恢复失败，原数据也还在。
 *
 * @param backupPath 备份目录完整路径；不传则用最近一份
 */
export function restoreBackup(backupPath?: string): RestoreBackupResult {
  const knowledgeDir = getKnowledgeDir()

  let sourcePath = backupPath
  if (!sourcePath) {
    const backups = listBackups()
    if (backups.length === 0) {
      return { success: false, error: '没有可用的备份' }
    }
    sourcePath = backups[0].path
  }

  if (!fs.existsSync(sourcePath)) {
    return { success: false, error: `备份目录不存在: ${sourcePath}` }
  }

  // 验证备份内容至少有 documents.json 或 lancedb/
  const hasDocs = fs.existsSync(path.join(sourcePath, 'documents.json'))
  const hasLancedb = fs.existsSync(path.join(sourcePath, 'lancedb'))
  if (!hasDocs && !hasLancedb) {
    return { success: false, error: '备份内容不完整（无 documents.json 也无 lancedb/）' }
  }

  try {
    // 把当前损坏的 knowledge/ 改名保留现场（如果存在）
    // rename 失败说明文件被占用（worker 未退出 / LanceDB 句柄未释放），
    // 此时不应 rmrf（可能数据丢失），直接抛出让调用方处理
    if (fs.existsSync(knowledgeDir)) {
      const brokenDir = path.join(
        path.dirname(knowledgeDir),
        `knowledge.broken-${Date.now()}`
      )
      try {
        fs.renameSync(knowledgeDir, brokenDir)
        log.info(`已保留损坏现场: ${brokenDir}`)
      } catch (e) {
        throw new Error(
          `无法重命名当前 knowledge 目录（文件可能被占用）: ` +
          `${e instanceof Error ? e.message : String(e)}。` +
          `请确保知识库已停止运行后重试。`
        )
      }
    }

    fs.mkdirSync(knowledgeDir, { recursive: true })
    copyDirSync(sourcePath, knowledgeDir)

    log.info(`从备份恢复完成: ${sourcePath}`)
    return { success: true, backupPath: sourcePath }
  } catch (e) {
    log.error('从备份恢复失败:', e)
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * 获取距离上次自动备份的时间（ms）；从未备份返回 Infinity
 */
export function msSinceLastAutoBackup(): number {
  try {
    const marker = getLastBackupMarkerPath()
    if (!fs.existsSync(marker)) return Infinity
    const last = parseInt(fs.readFileSync(marker, 'utf-8').trim(), 10)
    return Date.now() - last
  } catch {
    return Infinity
  }
}

/**
 * 删除指定备份
 */
export function deleteBackup(backupPath: string): boolean {
  const root = getBackupsRoot()
  // 安全检查：只允许删除 backups 目录下的内容
  // 必须用 path.sep 分隔，防止 knowledge-backups2/ 等前缀同名目录绕过
  const rootResolved = path.resolve(root)
  const targetResolved = path.resolve(backupPath)
  const isUnderRoot = targetResolved === rootResolved ||
    targetResolved.startsWith(rootResolved + path.sep)
  if (!isUnderRoot) {
    log.warn(`拒绝删除 backups 目录外的路径: ${backupPath}`)
    return false
  }
  rmrfSync(targetResolved)
  log.info(`已删除备份: ${backupPath}`)
  return true
}
