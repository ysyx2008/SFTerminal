/**
 * 主配置轻量滚动备份（独立于迁移整包 backups/）
 *
 * 目录：{userData}/config-backups/{iso}/
 * 目标：config / watches / scheduler / credentials / master.key
 *
 * 写前备份由 ConfigService 在 store.set 前调用；本模块不改 migrations/backup.ts。
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { app } from 'electron'
import { createLogger } from '../utils/logger'

const log = createLogger('ConfigBackup')

export const CONFIG_BACKUPS_DIRNAME = 'config-backups'
export const MAIN_CONFIG_FILENAME = 'qiyu-terminal-config.json'

const LITE_TARGETS = [
  { src: MAIN_CONFIG_FILENAME, kind: 'json' as const },
  { src: 'qiyu-terminal-watches.json', kind: 'json' as const },
  { src: 'qiyu-terminal-scheduler.json', kind: 'json' as const },
  { src: 'credentials.json', kind: 'json' as const },
  { src: 'master.key', kind: 'binary' as const },
]

/** 近期槽上限 */
export const MAX_RECENT_SNAPSHOTS = 20
/** 按天保底天数 */
export const MAX_DAY_FLOOR_DAYS = 30
/** 写前去抖 */
export const BACKUP_DEBOUNCE_MS = 5 * 60 * 1000
/** 启动补打：距上次快照超过此时长则补一份 */
export const STARTUP_BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type ConfigRecoveryKind = 'restored' | 'reset'

export interface ConfigRecoveryNotice {
  kind: ConfigRecoveryKind
  /** 恢复来源目录（仅 restored） */
  from?: string
  at: number
}

/** 持久化 notice，供 CLI 恢复后下次开桌面再提示 */
const NOTICE_FILENAME = 'config-recovery-notice.json'

let userDataOverride: string | null = null
let lastBackupAt = 0
let pendingNotice: ConfigRecoveryNotice | null = null
let dismissedNoticeKey: string | null = null

export function setConfigBackupUserDataForTest(dir: string | null): void {
  userDataOverride = dir
  lastBackupAt = 0
  pendingNotice = null
  dismissedNoticeKey = null
}

function getUserDataPath(): string {
  if (userDataOverride) return userDataOverride
  return app.getPath('userData')
}

function noticeFilePath(userDataPath = getUserDataPath()): string {
  return path.join(userDataPath, NOTICE_FILENAME)
}

function loadNoticeFromDisk(userDataPath = getUserDataPath()): ConfigRecoveryNotice | null {
  const p = noticeFilePath(userDataPath)
  if (!fs.existsSync(p)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as ConfigRecoveryNotice
    if (raw && (raw.kind === 'restored' || raw.kind === 'reset') && typeof raw.at === 'number') {
      return raw
    }
  } catch (err) {
    log.warn('Failed to read config recovery notice:', err)
  }
  return null
}

function persistNoticeToDisk(notice: ConfigRecoveryNotice | null, userDataPath = getUserDataPath()): void {
  const p = noticeFilePath(userDataPath)
  try {
    if (!notice) {
      if (fs.existsSync(p)) fs.unlinkSync(p)
      return
    }
    fs.writeFileSync(p, JSON.stringify(notice), 'utf-8')
  } catch (err) {
    log.warn('Failed to persist config recovery notice:', err)
  }
}

export function getConfigBackupsRoot(userDataPath = getUserDataPath()): string {
  return path.join(userDataPath, CONFIG_BACKUPS_DIRNAME)
}

function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function tryParseJsonObject(filePath: string): boolean {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    return isPlainObject(parsed)
  } catch {
    return false
  }
}

/**
 * 快照目录是否可恢复（结构可加载）。
 * credentials 若存在必须可 parse；master.key 若存在须非空。
 */
export function isRestorableConfigSnapshot(dir: string): boolean {
  const configPath = path.join(dir, MAIN_CONFIG_FILENAME)
  if (!fs.existsSync(configPath) || !tryParseJsonObject(configPath)) {
    return false
  }

  for (const t of LITE_TARGETS) {
    if (t.src === MAIN_CONFIG_FILENAME) continue
    const p = path.join(dir, t.src)
    if (!fs.existsSync(p)) continue
    if (t.kind === 'json') {
      if (!tryParseJsonObject(p)) return false
    } else {
      try {
        if (fs.statSync(p).size <= 0) return false
      } catch {
        return false
      }
    }
  }
  return true
}

function listSnapshotDirs(root: string): Array<{ name: string; path: string; mtime: number }> {
  if (!fs.existsSync(root)) return []
  const out: Array<{ name: string; path: string; mtime: number }> = []
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('.')) continue
    const p = path.join(root, name)
    try {
      const st = fs.statSync(p)
      if (!st.isDirectory()) continue
      out.push({ name, path: p, mtime: st.mtimeMs })
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function dayKey(mtimeMs: number): string {
  const d = new Date(mtimeMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** prune：先保 30 天日保底（每天最早一份），再裁近期槽到 20 */
export function pruneConfigBackups(root = getConfigBackupsRoot()): void {
  const all = listSnapshotDirs(root)
  if (all.length === 0) return

  const keep = new Set<string>()

  // 日保底：按日从新到旧，每天留 mtime 最早的一份，最多 MAX_DAY_FLOOR_DAYS 天
  const byDay = new Map<string, typeof all>()
  for (const e of all) {
    const k = dayKey(e.mtime)
    const list = byDay.get(k) ?? []
    list.push(e)
    byDay.set(k, list)
  }
  const dayKeys = [...byDay.keys()].sort((a, b) => b.localeCompare(a)).slice(0, MAX_DAY_FLOOR_DAYS)
  for (const k of dayKeys) {
    const list = byDay.get(k)!
    // 当天最早
    list.sort((a, b) => a.mtime - b.mtime)
    keep.add(list[0].path)
  }

  // 近期槽：按 mtime 最新的 MAX_RECENT_SNAPSHOTS
  for (const e of all.slice(0, MAX_RECENT_SNAPSHOTS)) {
    keep.add(e.path)
  }

  for (const e of all) {
    if (keep.has(e.path)) continue
    try {
      fs.rmSync(e.path, { recursive: true, force: true })
      log.info(`Pruned config backup: ${e.name}`)
    } catch (err) {
      log.warn(`Failed to prune ${e.name}:`, err)
    }
  }
}

function latestSnapshotConfigHash(root: string): string | null {
  for (const e of listSnapshotDirs(root)) {
    const configPath = path.join(e.path, MAIN_CONFIG_FILENAME)
    if (!fs.existsSync(configPath)) continue
    try {
      return sha256File(configPath)
    } catch {
      continue
    }
  }
  return null
}

function copyLiteTargets(userDataPath: string, destDir: string): number {
  let n = 0
  for (const t of LITE_TARGETS) {
    const src = path.join(userDataPath, t.src)
    if (!fs.existsSync(src)) continue
    const dest = path.join(destDir, t.src)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    n++
  }
  return n
}

/**
 * 无条件尝试打一份轻量快照（仍做合法/hash 检查）。
 * @returns 快照目录或 null
 */
export function createConfigBackup(
  userDataPath = getUserDataPath(),
  opts?: { force?: boolean }
): string | null {
  const root = getConfigBackupsRoot(userDataPath)
  const configPath = path.join(userDataPath, MAIN_CONFIG_FILENAME)

  if (!fs.existsSync(configPath)) {
    return null
  }
  if (!tryParseJsonObject(configPath)) {
    log.warn('Skip config backup: main config is not a valid JSON object')
    return null
  }

  const currentHash = sha256File(configPath)
  if (!opts?.force) {
    const latestHash = latestSnapshotConfigHash(root)
    if (latestHash && latestHash === currentHash) {
      lastBackupAt = Date.now()
      return null
    }
  }

  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const tmpDir = path.join(root, `.tmp-${iso}`)
  const finalDir = path.join(root, iso)

  try {
    fs.mkdirSync(tmpDir, { recursive: true })
    const n = copyLiteTargets(userDataPath, tmpDir)
    if (n === 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      return null
    }
    if (!isRestorableConfigSnapshot(tmpDir)) {
      log.warn('Skip config backup: post-copy check failed')
      fs.rmSync(tmpDir, { recursive: true, force: true })
      return null
    }

    const manifest = {
      ok: true,
      createdAt: Date.now(),
      configSha256: currentHash,
    }
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

    if (fs.existsSync(finalDir)) {
      fs.rmSync(finalDir, { recursive: true, force: true })
    }
    fs.renameSync(tmpDir, finalDir)
    lastBackupAt = Date.now()
    pruneConfigBackups(root)
    log.info(`Config backup created: ${finalDir}`)
    return finalDir
  } catch (err) {
    log.error('Config backup failed:', err)
    try {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
    return null
  }
}

/**
 * 写前调用：合法 + hash 去重 + 5 分钟去抖。失败只打日志，不抛。
 */
export function createConfigBackupIfNeeded(userDataPath = getUserDataPath()): void {
  const now = Date.now()
  if (lastBackupAt > 0 && now - lastBackupAt < BACKUP_DEBOUNCE_MS) {
    return
  }
  // 若磁盘上已有很新的快照（跨进程），也尊重去抖
  const root = getConfigBackupsRoot(userDataPath)
  const newest = listSnapshotDirs(root)[0]
  if (newest && now - newest.mtime < BACKUP_DEBOUNCE_MS) {
    lastBackupAt = newest.mtime
    return
  }
  createConfigBackup(userDataPath)
}

/** 启动时：无快照或距最新 >24h 则补打 */
export function ensureStartupConfigBackup(userDataPath = getUserDataPath()): void {
  const root = getConfigBackupsRoot(userDataPath)
  const newest = listSnapshotDirs(root)[0]
  const now = Date.now()
  if (!newest || now - newest.mtime >= STARTUP_BACKUP_MAX_AGE_MS) {
    createConfigBackup(userDataPath, { force: !newest })
  } else {
    lastBackupAt = newest.mtime
  }
}

export function findLatestRestorableConfigBackup(userDataPath = getUserDataPath()): string | null {
  const root = getConfigBackupsRoot(userDataPath)
  for (const e of listSnapshotDirs(root)) {
    if (isRestorableConfigSnapshot(e.path)) return e.path
  }

  // 只读回退：迁移整包 backups/
  const backupsRoot = path.join(userDataPath, 'backups')
  if (!fs.existsSync(backupsRoot)) return null
  const fullPacks: Array<{ path: string; mtime: number }> = []
  for (const name of fs.readdirSync(backupsRoot)) {
    if (name === 'config' || name.startsWith('.')) continue
    const p = path.join(backupsRoot, name)
    try {
      const st = fs.statSync(p)
      if (!st.isDirectory()) continue
      fullPacks.push({ path: p, mtime: st.mtimeMs })
    } catch {
      // skip
    }
  }
  fullPacks.sort((a, b) => b.mtime - a.mtime)
  for (const e of fullPacks) {
    if (isRestorableConfigSnapshot(e.path)) return e.path
  }
  return null
}

/**
 * 从快照恢复 lite 文件到 userData。
 * credentials 在快照中存在时必须拷成功，否则整份失败。
 */
export function restoreConfigFromBackup(
  snapshotDir: string,
  userDataPath = getUserDataPath()
): boolean {
  if (!isRestorableConfigSnapshot(snapshotDir)) {
    log.warn(`Restore rejected, snapshot not restorable: ${snapshotDir}`)
    return false
  }

  const staging = path.join(userDataPath, `.config-restore-${Date.now()}`)
  try {
    fs.mkdirSync(staging, { recursive: true })
    let copied = 0
    let hadCredentials = false
    for (const t of LITE_TARGETS) {
      const src = path.join(snapshotDir, t.src)
      if (!fs.existsSync(src)) continue
      if (t.src === 'credentials.json' || t.src === 'master.key') {
        hadCredentials = true
      }
      const dest = path.join(staging, t.src)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
      copied++
    }
    if (copied === 0 || !isRestorableConfigSnapshot(staging)) {
      fs.rmSync(staging, { recursive: true, force: true })
      return false
    }
    if (hadCredentials) {
      const credSrc = path.join(snapshotDir, 'credentials.json')
      const keySrc = path.join(snapshotDir, 'master.key')
      if (fs.existsSync(credSrc) && !fs.existsSync(path.join(staging, 'credentials.json'))) {
        fs.rmSync(staging, { recursive: true, force: true })
        return false
      }
      if (fs.existsSync(keySrc) && !fs.existsSync(path.join(staging, 'master.key'))) {
        fs.rmSync(staging, { recursive: true, force: true })
        return false
      }
    }

    const ts = Date.now()
    const replaced: string[] = []
    for (const t of LITE_TARGETS) {
      const staged = path.join(staging, t.src)
      if (!fs.existsSync(staged)) continue
      const target = path.join(userDataPath, t.src)
      if (fs.existsSync(target)) {
        const bak = `${target}.bak.${ts}`
        fs.copyFileSync(target, bak)
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(staged, target)
      replaced.push(t.src)
    }

    const mainPath = path.join(userDataPath, MAIN_CONFIG_FILENAME)
    if (!tryParseJsonObject(mainPath)) {
      log.error('Restore failed: main config invalid after copy; rolling back')
      for (const name of replaced) {
        const target = path.join(userDataPath, name)
        const bak = `${target}.bak.${ts}`
        try {
          if (fs.existsSync(bak)) {
            fs.copyFileSync(bak, target)
          }
        } catch (rbErr) {
          log.error(`Rollback failed for ${name}:`, rbErr)
        }
      }
      fs.rmSync(staging, { recursive: true, force: true })
      return false
    }

    fs.rmSync(staging, { recursive: true, force: true })
    log.info(`Config restored from ${snapshotDir}`)
    return true
  } catch (err) {
    log.error('Config restore failed:', err)
    try {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true })
    } catch {
      // ignore
    }
    return false
  }
}

/** 尝试从滚动备份（及 backups/ 整包回退）恢复；成功返回来源路径 */
export function tryRestoreConfigFromBackups(userDataPath = getUserDataPath()): string | null {
  const root = getConfigBackupsRoot(userDataPath)
  for (const e of listSnapshotDirs(root)) {
    if (!isRestorableConfigSnapshot(e.path)) {
      log.warn(`Skipping unrestorable snapshot: ${e.name}`)
      continue
    }
    if (restoreConfigFromBackup(e.path, userDataPath)) {
      return e.path
    }
  }

  const backupsRoot = path.join(userDataPath, 'backups')
  if (!fs.existsSync(backupsRoot)) return null
  const fullPacks: Array<{ name: string; path: string; mtime: number }> = []
  for (const name of fs.readdirSync(backupsRoot)) {
    if (name.startsWith('.')) continue
    const p = path.join(backupsRoot, name)
    try {
      const st = fs.statSync(p)
      if (!st.isDirectory()) continue
      fullPacks.push({ name, path: p, mtime: st.mtimeMs })
    } catch {
      // skip
    }
  }
  fullPacks.sort((a, b) => b.mtime - a.mtime)
  for (const e of fullPacks) {
    if (!isRestorableConfigSnapshot(e.path)) continue
    if (restoreConfigFromBackup(e.path, userDataPath)) {
      return e.path
    }
  }
  return null
}

export function setConfigRecoveryNotice(notice: ConfigRecoveryNotice): void {
  pendingNotice = notice
  dismissedNoticeKey = null
  persistNoticeToDisk(notice)
  const msg =
    notice.kind === 'restored'
      ? `配置已从备份恢复（${notice.from || 'snapshot'}），请核对 AI / SSH 等设置是否齐全`
      : '配置无法自动恢复，已重置为默认值，请重新配置大模型等'
  log.error(`[CONFIG RECOVERY] ${msg}`)
}

export function peekConfigRecoveryNotice(): ConfigRecoveryNotice | null {
  if (!pendingNotice) {
    pendingNotice = loadNoticeFromDisk()
  }
  if (!pendingNotice) return null
  const key = `${pendingNotice.kind}:${pendingNotice.at}`
  if (dismissedNoticeKey === key) return null
  return pendingNotice
}

/** 与 peek 相同（不 dismiss）。弹窗/横幅共用 peek；关闭横幅时再 dismiss。 */
export function consumeConfigRecoveryNotice(): ConfigRecoveryNotice | null {
  return peekConfigRecoveryNotice()
}

export function dismissConfigRecoveryNotice(): void {
  const n = peekConfigRecoveryNotice()
  if (!n) return
  dismissedNoticeKey = `${n.kind}:${n.at}`
  pendingNotice = null
  persistNoticeToDisk(null)
}
