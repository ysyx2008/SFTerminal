import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { createLogger } from '../utils/logger'
import { writeFileAtomic } from '../utils/atomic-write'
import {
  cleanupExpiredMigratedBackups,
  collectAgentStorageStats,
  getAgentRecordPath,
  getLegacyAgentDayFilePath,
  listAgentDateDirs,
  listLegacyAgentDayFiles,
  listSessionFilesInDateDir,
  readAgentRecordFile,
  readAgentRecordFileAsync,
  readLegacyAgentDayRecords,
  writeAgentRecordFile,
} from './history/agent-storage'

const log = createLogger('History')

// ==================== 类型定义 ====================

// 从共享类型导入并重新导出
import type { TerminalType, AgentRecord, TokenUsage, AgentHistorySummary } from '@shared/types'
export type { AgentStepRecord, AgentRecord, AgentHistorySummary } from '@shared/types'

export interface ChatRecord {
  id: string
  timestamp: number
  terminalId: string
  terminalType: TerminalType
  sshHost?: string
  role: 'user' | 'assistant'
  content: string
}

/**
 * Watch（关切）Agent 的身份 key。规范来源是 `AgentService.WATCH_AGENT_ID`，
 * 但 history.service 是底层叶子服务，反向 import AgentService 会成环，故按
 * 既有惯例（registry.ts / terminal.ts 各自定义 '__companion__' 常量）本地定义。
 * 用途：把 watch 的「内心独白」执行记录与用户/联络任务**物理隔离**到独立的
 * 历史树和索引，避免高频内心独白把主索引压舱（曾达 149MB）。
 */
const WATCH_AGENT_KEY = '__watch__'

/**
 * watch 索引条目里 userTask 的截断长度。watch 的 userTask 是心跳模板展开的长 prompt
 * （平均 ~2.6KB），但索引里只用作审计列表标题，整段存会让 watch-index 重新膨胀。
 * 正文完整保存在 watch 树日文件中，索引只留可读的标题前缀。
 */
const WATCH_INDEX_USERTASK_MAX = 200

/** 索引条目：每条 AgentRecord 的轻量摘要，用于排序和过滤，避免读取完整日期文件 */
interface AgentIndexEntry {
  id: string
  timestamp: number
  duration: number
  dateStr: string
  userTask: string
  terminalType: TerminalType
  /** Agent 的身份 key，来自 AgentRecord.agentKey（如 '__companion__'、'__watch__'） */
  agentKey?: string
  sshHost?: string
  status: 'completed' | 'failed' | 'aborted'
  tokenUsage?: TokenUsage
}

/**
 * 一个独立的「记录树 + 索引文件 + 内存缓存」三元组。
 * 主索引（agentStore）放用户/联络/终端任务；watch 索引（watchStore）放关切内心独白。
 * 两者结构相同、方法复用，只是目录/索引路径/缓存不同。
 */
interface AgentIndexStore {
  /** 记录正文所在目录（history/agent 或 history/watch） */
  dir: string
  /** 索引文件路径 */
  indexPath: string
  /** 常驻内存索引缓存 */
  cache: AgentIndexEntry[] | null
  /** 写索引条目时截断 userTask 的长度（仅 watch 用，避免内心独白长 prompt 撑大索引） */
  userTaskMaxLen?: number
}

/** Token 用量统计时段数据 */
export interface TokenUsagePeriodStats {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cache_hit_tokens: number
  cache_miss_tokens: number
  taskCount: number
}

/** Token 用量统计结果 */
export interface TokenUsageStatsResult {
  total: TokenUsagePeriodStats
  today: TokenUsagePeriodStats
  last7Days: TokenUsagePeriodStats
  last30Days: TokenUsagePeriodStats
  daily: Array<{ date: string } & TokenUsagePeriodStats>
}

export interface SearchAgentRecordsOptions {
  keyword?: string
  limit?: number
  startDate?: string
  endDate?: string
  /** 与 getRecentAgentRecords 的 filter 一致，在关键字/日期匹配后再过滤 */
  filter?: (r: AgentRecord) => boolean
  /** 为 true 时仅匹配 userTask（列表标题），不扫 finalResult/steps，适合实时筛选 */
  titleOnly?: boolean
}

export interface SearchAgentRecordsResult {
  records: AgentRecord[]
  totalMatched: number
  hasMore: boolean
}

export interface HostProfileData {
  hostId: string
  hostname: string
  username: string
  os: string
  osVersion?: string
  shell: string
  packageManager?: string
  installedTools: string[]
  homeDir?: string
  currentDir?: string
  notes?: string[]
  lastProbed?: number
  lastUpdated?: number
}

// ==================== 历史记录服务 ====================

export class HistoryService {
  private historyDir: string
  private chatDir: string
  private agentDir: string
  /** watch（关切）内心独白记录的独立历史树，与 agentDir 隔离 */
  private watchDir: string
  private imagesDir: string
  /** 主索引存储：用户/联络/终端任务记录（不含 watch 内心独白） */
  private agentStore!: AgentIndexStore
  /** watch 索引存储：关切执行记录，与主索引隔离，避免内心独白压舱主索引 */
  private watchStore!: AgentIndexStore

  constructor() {
    // 获取用户数据目录
    const userDataPath = app.getPath('userData')
    this.historyDir = path.join(userDataPath, 'history')
    this.chatDir = path.join(this.historyDir, 'chat')
    this.agentDir = path.join(this.historyDir, 'agent')
    this.watchDir = path.join(this.historyDir, 'watch')
    this.imagesDir = path.join(this.historyDir, 'images')

    this.agentStore = {
      dir: this.agentDir,
      indexPath: path.join(this.historyDir, 'agent-index.json'),
      cache: null,
    }
    this.watchStore = {
      dir: this.watchDir,
      indexPath: path.join(this.historyDir, 'watch-index.json'),
      cache: null,
      userTaskMaxLen: WATCH_INDEX_USERTASK_MAX,
    }

    // 确保目录存在
    this.ensureDirectories()
    cleanupExpiredMigratedBackups(this.agentDir)
  }

  /**
   * 确保历史记录目录存在
   */
  private ensureDirectories(): void {
    const dirs = [this.historyDir, this.chatDir, this.agentDir, this.watchDir, this.imagesDir]
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
  }

  /**
   * 把 AgentRecord 里所有步骤中内联的 base64 图片写到磁盘，替换为 file:// 路径。
   * 解决长会话（大量截图）IPC 传输超大对象导致渲染进程崩溃的问题。
   * @returns true 表示发生了替换（调用方需要回写记录文件）
   */
  private externalizeStepImages(record: AgentRecord): boolean {
    let anyChanged = false
    const dateStr = this.getDateString(record.timestamp)
    const sessionImagesDir = path.join(this.imagesDir, dateStr, record.id)

    for (const step of record.steps) {
      if (!step.images || step.images.length === 0) continue

      let stepChanged = false
      const newImages: string[] = []
      for (let i = 0; i < step.images.length; i++) {
        const img = step.images[i]

        // 把旧的 file:// 绝对路径（上一版写入的格式）转为 sft-local:// 协议 URL
        if (img.startsWith('file://')) {
          const absPath = img.slice('file://'.length)
          if (absPath.startsWith(this.imagesDir)) {
            const relPath = path.relative(this.imagesDir, absPath).replace(/\\/g, '/')
            newImages.push(`sft-local://history-image/${relPath}`)
            stepChanged = true
            continue
          }
          newImages.push(img)
          continue
        }

        // 已是 sft-local:// 格式，直接保留
        if (img.startsWith('sft-local://')) {
          newImages.push(img)
          continue
        }

        // 内联 base64 data URL：写出到磁盘，替换为 sft-local:// 路径
        const match = img.match(/^data:(image\/(\w+));base64,(.+)$/)
        if (!match) {
          newImages.push(img)
          continue
        }
        const [, , ext, base64Data] = match
        // 确保 session 图片目录存在（懒建）
        if (!fs.existsSync(sessionImagesDir)) {
          fs.mkdirSync(sessionImagesDir, { recursive: true })
        }
        const filename = `${step.id}-${i}.${ext}`
        const filePath = path.join(sessionImagesDir, filename)
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'))
        }
        const relPath = path.relative(this.imagesDir, filePath).replace(/\\/g, '/')
        newImages.push(`sft-local://history-image/${relPath}`)
        stepChanged = true
      }
      if (stepChanged) {
        step.images = newImages
        anyChanged = true
      }
    }

    return anyChanged
  }

  /**
   * 递归复制目录
   */
  private copyDirectory(src: string, dest: string): void {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true })
    }
    const entries = fs.readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)
      if (entry.isDirectory()) {
        this.copyDirectory(srcPath, destPath)
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  /**
   * 合并目录（不覆盖已存在的文件）
   */
  private mergeDirectory(src: string, dest: string): void {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true })
    }
    const entries = fs.readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)
      if (entry.isDirectory()) {
        this.mergeDirectory(srcPath, destPath)
      } else if (!fs.existsSync(destPath)) {
        // 只有目标文件不存在时才复制
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  /**
   * 获取当前日期字符串（用于文件名）
   */
  private getDateString(timestamp?: number): string {
    const date = timestamp ? new Date(timestamp) : new Date()
    return date.toISOString().split('T')[0]  // YYYY-MM-DD
  }

  /**
   * 获取指定日期的聊天记录文件路径
   */
  private getChatFilePath(dateStr: string): string {
    return path.join(this.chatDir, `${dateStr}.json`)
  }

  private onCorruptRecord(corruptPath: string | null, error: unknown): void {
    log.error(`损坏记录已隔离: ${corruptPath ?? '(rename failed)'}`, error)
  }

  private readAgentRecordFromDisk(dateStr: string, id: string): AgentRecord | undefined {
    // 先查主 agent 树，再查 watch 树（watch 记录已拆分到独立目录）
    for (const dir of [this.agentDir, this.watchDir]) {
      const record = readAgentRecordFile(
        getAgentRecordPath(dir, dateStr, id),
        (p, e) => this.onCorruptRecord(p, e)
      )
      if (record) return record
    }

    const legacyRecords = readLegacyAgentDayRecords(
      getLegacyAgentDayFilePath(this.agentDir, dateStr),
      (p, e) => this.onCorruptRecord(p, e)
    )
    return legacyRecords.find(r => r.id === id)
  }

  private async readAgentRecordFromDiskAsync(dateStr: string, id: string): Promise<AgentRecord | undefined> {
    for (const dir of [this.agentDir, this.watchDir]) {
      const record = await readAgentRecordFileAsync(
        getAgentRecordPath(dir, dateStr, id),
        (p, e) => this.onCorruptRecord(p, e)
      )
      if (record) return record
    }

    const legacyRecords = readLegacyAgentDayRecords(
      getLegacyAgentDayFilePath(this.agentDir, dateStr),
      (p, e) => this.onCorruptRecord(p, e)
    )
    return legacyRecords.find(r => r.id === id)
  }

  /**
   * 读取 JSON 文件
   */
  private readJsonFile<T>(filePath: string): T[] {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8')
        return JSON.parse(content) as T[]
      }
    } catch (e) {
      log.error(`读取历史文件失败: ${filePath}`, e)
    }
    return []
  }

  /** 异步读取 JSON 数组文件（fs.promises，await 让出事件循环，避免阻塞主进程） */
  private async readJsonFileAsync<T>(filePath: string): Promise<T[]> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8')
      return JSON.parse(content) as T[]
    } catch (e) {
      log.error(`读取历史文件失败: ${filePath}`, e)
      return []
    }
  }

  // ==================== Agent 索引管理 ====================

  /** 选择记录归属的索引存储：watch 内心独白进独立索引，其余进主索引 */
  private storeForRecord(record: AgentRecord): AgentIndexStore {
    return record.agentKey === WATCH_AGENT_KEY ? this.watchStore : this.agentStore
  }

  private getIndexFor(store: AgentIndexStore): AgentIndexEntry[] {
    if (store.cache) return store.cache

    try {
      if (fs.existsSync(store.indexPath)) {
        store.cache = JSON.parse(fs.readFileSync(store.indexPath, 'utf-8')) as AgentIndexEntry[]
        return store.cache
      }
    } catch (e) {
      log.warn(`读取索引失败，将重建 (${path.basename(store.indexPath)}):`, e)
    }

    return this.rebuildIndexFor(store)
  }

  private writeIndexFor(store: AgentIndexStore, entries: AgentIndexEntry[]): void {
    store.cache = entries
    try {
      writeFileAtomic(store.indexPath, JSON.stringify(entries))
    } catch (e) {
      log.error(`写入索引失败 (${path.basename(store.indexPath)}):`, e)
    }
  }

  /** 从某个存储的所有会话文件重建其索引 */
  private rebuildIndexFor(store: AgentIndexStore): AgentIndexEntry[] {
    const entries: AgentIndexEntry[] = []

    for (const dateStr of listAgentDateDirs(store.dir)) {
      const dateDir = path.join(store.dir, dateStr)
      for (const file of listSessionFilesInDateDir(store.dir, dateStr)) {
        const filePath = path.join(dateDir, file)
        const record = readAgentRecordFile(filePath, (p, e) => this.onCorruptRecord(p, e))
        if (record) entries.push(this.toIndexEntry(record, dateStr, store.userTaskMaxLen))
      }
    }

    // 旧格式日文件只可能出现在主 agent 目录（v5 之前）；watch 目录由 v6 拆分得来，无旧日文件
    for (const file of listLegacyAgentDayFiles(store.dir)) {
      const dateStr = file.replace('.json', '')
      const records = readLegacyAgentDayRecords(
        path.join(store.dir, file),
        (p, e) => this.onCorruptRecord(p, e)
      )
      for (const r of records) {
        entries.push(this.toIndexEntry(r, dateStr, store.userTaskMaxLen))
      }
    }

    this.writeIndexFor(store, entries)
    log.info(`索引已重建 (${path.basename(store.indexPath)})，共 ${entries.length} 条记录`)
    return entries
  }

  /** 兼容旧调用：默认作用于主 agent 索引 */
  private getIndex(): AgentIndexEntry[] {
    return this.getIndexFor(this.agentStore)
  }

  /** 兼容旧调用：默认写主 agent 索引 */
  private writeIndex(entries: AgentIndexEntry[]): void {
    this.writeIndexFor(this.agentStore, entries)
  }

  /** 从磁盘重建全部索引（主 + watch）。首次升级、索引损坏或 v6 迁移后触发 */
  rebuildAgentIndex(): void {
    this.agentStore.cache = null
    this.watchStore.cache = null
    this.rebuildIndexFor(this.agentStore)
    this.rebuildIndexFor(this.watchStore)
  }

  private toIndexEntry(record: AgentRecord, dateStr: string, userTaskMaxLen?: number): AgentIndexEntry {
    const userTask = userTaskMaxLen && record.userTask.length > userTaskMaxLen
      ? record.userTask.slice(0, userTaskMaxLen)
      : record.userTask
    const entry: AgentIndexEntry = {
      id: record.id,
      timestamp: record.timestamp,
      duration: record.duration,
      dateStr,
      userTask,
      terminalType: record.terminalType,
      agentKey: record.agentKey,
      sshHost: record.sshHost,
      status: record.status,
    }
    if (record.tokenUsage) {
      entry.tokenUsage = record.tokenUsage
    }
    return entry
  }

  private updateIndexEntryFor(store: AgentIndexStore, record: AgentRecord): void {
    const entries = this.getIndexFor(store)
    const dateStr = this.getDateString(record.timestamp)
    const entry = this.toIndexEntry(record, dateStr, store.userTaskMaxLen)

    const idx = entries.findIndex(e => e.id === record.id)
    if (idx !== -1) {
      entries[idx] = entry
    } else {
      entries.push(entry)
    }

    this.writeIndexFor(store, entries)
  }

  /**
   * 写入 JSON 文件
   */
  private writeJsonFile<T>(filePath: string, data: T[]): void {
    try {
      writeFileAtomic(filePath, JSON.stringify(data, null, 2))
    } catch (e) {
      log.error(`写入历史文件失败: ${filePath}`, e)
    }
  }

  // ==================== 聊天记录 ====================

  /**
   * 保存聊天记录
   */
  saveChatRecord(record: ChatRecord): void {
    const dateStr = this.getDateString(record.timestamp)
    const filePath = this.getChatFilePath(dateStr)
    const records = this.readJsonFile<ChatRecord>(filePath)
    records.push(record)
    this.writeJsonFile(filePath, records)
  }

  /**
   * 批量保存聊天记录
   */
  saveChatRecords(records: ChatRecord[]): void {
    // 按日期分组
    const grouped = new Map<string, ChatRecord[]>()
    for (const record of records) {
      const dateStr = this.getDateString(record.timestamp)
      if (!grouped.has(dateStr)) {
        grouped.set(dateStr, [])
      }
      grouped.get(dateStr)!.push(record)
    }

    // 分别保存到各日期文件
    for (const [dateStr, dateRecords] of Array.from(grouped.entries())) {
      const filePath = this.getChatFilePath(dateStr)
      const existing = this.readJsonFile<ChatRecord>(filePath)
      this.writeJsonFile(filePath, [...existing, ...dateRecords])
    }
  }

  /**
   * 获取指定日期范围的聊天记录
   */
  getChatRecords(startDate?: string, endDate?: string): ChatRecord[] {
    const files = fs.readdirSync(this.chatDir).filter(f => f.endsWith('.json')).sort()
    const records: ChatRecord[] = []

    for (const file of files) {
      const dateStr = file.replace('.json', '')
      if (startDate && dateStr < startDate) continue
      if (endDate && dateStr > endDate) continue

      const filePath = path.join(this.chatDir, file)
      records.push(...this.readJsonFile<ChatRecord>(filePath))
    }

    return records.sort((a, b) => a.timestamp - b.timestamp)
  }

  // ==================== Agent 记录 ====================

  /**
   * 保存 Agent 记录（支持更新：如果 id 相同则更新，否则追加）
   */
  saveAgentRecord(record: AgentRecord): void {
    // 写入前把内联 base64 图片外化到磁盘，避免 JSON 文件膨胀和 IPC 传输超大对象
    this.externalizeStepImages(record)
    // 剥离可从磁盘重生的 Canvas content（md/html 文件），避免大文件撑爆历史记录
    this.stripRederivableCanvasContent(record)

    const store = this.storeForRecord(record)
    writeAgentRecordFile(store.dir, record)
    this.updateIndexEntryFor(store, record)
  }

  /**
   * 保存（或更新）产出物面板清单到指定记录。
   * 自动剥离 contentFromFile 的 content（可从磁盘重生），避免大文件撑爆历史记录。
   */
  saveArtifacts(recordId: string, artifacts: import('@shared/types').CanvasArtifact[]): void {
    const record = this.getAgentRecordById(recordId)
    if (!record) return
    record.artifacts = artifacts.map(a => {
      if (a.contentFromFile) return { ...a, content: '' }
      return a
    })
    this.saveAgentRecord(record)
  }

  /**
   * 剥离 `canvasData.content` 中可从 `filePath` 磁盘文件重生的内容（`contentFromFile`）。
   * 仅作用于待写盘的 record 副本：克隆 canvasData 后删除 content，绝不改动调用方
   * （Agent 的 `_sessionSteps`）持有的共享对象，避免破坏正在进行会话的实时预览。
   * 恢复时由前端按 `filePath` 读盘回填（见 artifact store hydrate）。
   */
  private stripRederivableCanvasContent(record: AgentRecord): void {
    record.steps = record.steps.map((step) => {
      const cd = step.canvasData
      if (!cd?.contentFromFile || !cd.filePath || cd.content === undefined) {
        return step
      }
      return { ...step, canvasData: { ...cd, content: undefined } }
    })
  }

  /**
   * 获取指定日期范围的 Agent 记录
   */
  getAgentRecords(startDate?: string, endDate?: string): AgentRecord[] {
    const records: AgentRecord[] = []

    for (const dateStr of listAgentDateDirs(this.agentDir)) {
      if (startDate && dateStr < startDate) continue
      if (endDate && dateStr > endDate) continue

      for (const file of listSessionFilesInDateDir(this.agentDir, dateStr)) {
        const recordId = file.replace(/\.json$/, '')
        const record = readAgentRecordFile(
          getAgentRecordPath(this.agentDir, dateStr, recordId),
          (p, e) => this.onCorruptRecord(p, e)
        )
        if (record) records.push(record)
      }
    }

    for (const file of listLegacyAgentDayFiles(this.agentDir)) {
      const dateStr = file.replace('.json', '')
      if (startDate && dateStr < startDate) continue
      if (endDate && dateStr > endDate) continue
      records.push(...readLegacyAgentDayRecords(
        path.join(this.agentDir, file),
        (p, e) => this.onCorruptRecord(p, e)
      ))
    }

    return records.sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * 按 ID 查找 Agent 记录（跨日期文件查找）。
   * 对存量记录中内联的 base64 图片做 lazy 外化：首次访问时写到磁盘并回写 JSON，
   * 后续访问直接读 file:// 路径，IPC 传输体积从几十 MB 降到几百 KB。
   */
  getAgentRecordById(id: string): AgentRecord | undefined {
    // 主索引优先，未命中再查 watch 索引（watch 记录在独立索引中）
    const entry = this.getIndex().find(e => e.id === id)
      ?? this.getIndexFor(this.watchStore).find(e => e.id === id)
    if (entry) {
      const found = this.readAgentRecordFromDisk(entry.dateStr, id)
      if (!found) return undefined
      return this.maybeExternalizeAndSaveRecord(found, entry.dateStr)
    }

    // 兜底全盘扫描：合并两棵树的日期目录，按日期倒序找
    const dateDirs = new Set<string>([
      ...listAgentDateDirs(this.agentDir),
      ...listAgentDateDirs(this.watchDir),
    ])
    for (const dateStr of [...dateDirs].sort().reverse()) {
      const found = this.readAgentRecordFromDisk(dateStr, id)
      if (found) return this.maybeExternalizeAndSaveRecord(found, dateStr)
    }

    for (const file of [...listLegacyAgentDayFiles(this.agentDir)].reverse()) {
      const dateStr = file.replace('.json', '')
      const found = this.readAgentRecordFromDisk(dateStr, id)
      if (found) return this.maybeExternalizeAndSaveRecord(found, dateStr)
    }

    return undefined
  }

  private maybeExternalizeAndSaveRecord(found: AgentRecord, dateStr: string): AgentRecord {
    const changed = this.externalizeStepImages(found)
    if (changed) {
      const store = this.storeForRecord(found)
      writeAgentRecordFile(store.dir, found)
      this.updateIndexEntryFor(store, found)
      log.info(`Externalized inline images for record ${found.id}, saved back to session file`)
    }
    return found
  }

  /**
   * 按 ID 删除单条 Agent 记录（日文件、索引、关联截图目录）。
   * @returns 是否成功删除（记录不存在时返回 false）
   */
  deleteAgentRecord(id: string): boolean {
    // 主索引优先，未命中再查 watch 索引——确保 watch 记录也能正确删除文件/索引/截图
    let store = this.agentStore
    let index = this.getIndexFor(store)
    let entry = index.find(e => e.id === id)
    if (!entry) {
      store = this.watchStore
      index = this.getIndexFor(store)
      entry = index.find(e => e.id === id)
    }
    if (!entry) return false

    const sessionPath = getAgentRecordPath(store.dir, entry.dateStr, id)
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath)
    } else {
      // 兼容尚未迁移的旧日文件：从数组中剔除该条记录（仅主 agent 树可能有旧日文件）
      const legacyPath = getLegacyAgentDayFilePath(store.dir, entry.dateStr)
      if (fs.existsSync(legacyPath)) {
        const legacyRecords = readLegacyAgentDayRecords(legacyPath, (p, e) => this.onCorruptRecord(p, e))
        const filtered = legacyRecords.filter(r => r.id !== id)
        if (filtered.length !== legacyRecords.length) {
          if (filtered.length === 0) {
            fs.unlinkSync(legacyPath)
          } else {
            writeFileAtomic(legacyPath, JSON.stringify(filtered, null, 2))
          }
        }
      }
    }

    const dateDir = path.join(store.dir, entry.dateStr)
    if (fs.existsSync(dateDir) && fs.readdirSync(dateDir).length === 0) {
      fs.rmdirSync(dateDir)
    }

    this.writeIndexFor(store, index.filter(e => e.id !== id))

    const sessionImagesDir = path.join(this.imagesDir, entry.dateStr, id)
    if (fs.existsSync(sessionImagesDir)) {
      fs.rmSync(sessionImagesDir, { recursive: true, force: true })
    }

    log.info(`已删除 Agent 历史记录: ${id}`)
    return true
  }

  /**
   * 获取最近的 N 条 Agent 记录，按最后更新时间（timestamp + duration）倒序排列。
   * 基于轻量级索引选出 top N，再只读取必要的日期文件获取完整记录。
   */
  getRecentAgentRecords(limit: number = 5, filter?: (r: AgentRecord) => boolean): AgentRecord[] {
    const index = this.getIndex()

    // 索引条目包含 filter 所需字段（userTask 等），用 cast 适配现有签名
    let candidates = filter
      ? index.filter(e => filter(e as unknown as AgentRecord))
      : index

    candidates = candidates
      .sort((a, b) => (b.timestamp + b.duration) - (a.timestamp + a.duration))
      .slice(0, limit)

    if (candidates.length === 0) return []

    // 按 dateStr 分组，最小化文件读取次数
    const results: AgentRecord[] = []
    for (const entry of candidates) {
      const record = this.readAgentRecordFromDisk(entry.dateStr, entry.id)
      if (record) results.push(record)
    }

    return results.sort((a, b) => (b.timestamp + b.duration) - (a.timestamp + a.duration))
  }

  /**
   * 取某个 agentKey（如 '__companion__'）最近的一条完整会话记录。
   * 用于联络常驻 tab 打开/重启后恢复上次对话。无匹配返回 undefined。
   */
  getLatestRecordByAgentKey(agentKey: string): AgentRecord | undefined {
    return this.getRecentAgentRecords(1, r => r.agentKey === agentKey)[0]
  }

  /**
   * 取某个 agentKey 最近的 N 条完整会话记录（按最后活跃时间倒序）。
   * 联络常驻 tab 恢复时合并展示，避免重启后只看到最后一条会话。
   */
  getRecentRecordsByAgentKey(agentKey: string, limit: number = 10): AgentRecord[] {
    return this.getRecentAgentRecords(limit, r => r.agentKey === agentKey)
  }

  /**
   * 取最近 N 条 watch（关切）执行记录，按最后活跃时间倒序。
   * 数据源是独立的 watch 索引/树（与主历史隔离），供关切执行审计使用，不进主历史列表。
   */
  getRecentWatchRecords(limit: number = 20, filter?: (r: AgentRecord) => boolean): AgentRecord[] {
    let candidates = this.getIndexFor(this.watchStore)
    if (filter) {
      candidates = candidates.filter(e => filter(e as unknown as AgentRecord))
    }
    const top = [...candidates]
      .sort((a, b) => (b.timestamp + b.duration) - (a.timestamp + a.duration))
      .slice(0, limit)

    const records: AgentRecord[] = []
    for (const entry of top) {
      const record = this.readAgentRecordFromDisk(entry.dateStr, entry.id)
      if (record) records.push(record)
    }
    return records
  }

  /**
   * 列出全部 Agent 历史的轻量摘要（来自 agent-index.json，不读各日 JSON）。
   * 按「最后活跃时间」timestamp + duration 倒序。
   */
  listAgentHistorySummaries(excludeWakeup?: boolean): AgentHistorySummary[] {
    const index = this.getIndex()
    let entries = [...index]
    if (excludeWakeup) {
      // watch 内心独白已存独立索引、本就不在主索引中；此处保留为结构化防御过滤
      // （取代旧的 userTask 关键词前缀匹配），万一有遗留也能挡住。
      entries = entries.filter(e => e.agentKey !== WATCH_AGENT_KEY)
    }
    entries.sort((a, b) => (b.timestamp + b.duration) - (a.timestamp + a.duration))
    return entries.map(e => ({
      id: e.id,
      timestamp: e.timestamp,
      duration: e.duration,
      userTask: e.userTask,
      terminalType: e.terminalType,
      agentKey: e.agentKey,
      sshHost: e.sshHost,
      status: e.status,
    }))
  }

  /**
   * 关键字搜索 Agent 历史记录
   * 搜索范围：userTask、finalResult、以及过程中用户追加的消息（user_task / user_supplement steps）
   */
  async searchAgentRecords(keyword: string, limit: number = 10): Promise<AgentRecord[]> {
    return (await this.searchAgentRecordsAdvanced({ keyword, limit })).records
  }

  /**
   * 高级搜索 Agent 历史记录
   * 支持关键字搜索、时间范围过滤，以及 hasMore 提示。
   * `titleOnly: true` 时仅匹配 userTask，不扫描 finalResult / steps，适合高频实时筛选。
   *
   * 性能：先用内存索引（含 userTask/timestamp 等）筛出候选，再按需异步读取日期文件。
   * - titleOnly：关键字匹配在索引层完成，仅为前 limit 条命中读回完整记录，零全量扫描；
   * - full：关键字可能命中 finalResult/steps 正文，须读完整记录二次匹配，但仅读「时间窗 +
   *   filter 命中」的候选所在文件，且逐文件 `await`（fs.promises）让出事件循环，避免历史量大时
   *   同步遍历阻塞主进程导致界面冻结。
   *
   * 索引为搜索唯一候选来源，与 `getRecentAgentRecords` / `listAgentHistorySummaries` 的假设一致
   * （索引在 saveAgentRecord 时同步更新，缺失时 rebuildIndex 全量重建）。`filter` 直接作用于索引
   * 条目（cast），与 `getRecentAgentRecords` 同款——现有 filter（excludeWakeup）仅依赖 userTask。
   */
  async searchAgentRecordsAdvanced(options: SearchAgentRecordsOptions): Promise<SearchAgentRecordsResult> {
    const keyword = options.keyword?.trim() ?? ''
    if (!keyword && !options.startDate && !options.endDate) {
      return { records: [], totalMatched: 0, hasMore: false }
    }

    const lowerKeyword = keyword.toLowerCase()
    const hasKeyword = lowerKeyword.length > 0
    const limit = Math.max(1, options.limit ?? 10)
    const titleOnly = options.titleOnly === true
    const startTs = this.parseDateBoundary(options.startDate, 'start')
    const endTs = this.parseDateBoundary(options.endDate, 'end')

    // ── 候选筛选（零文件读）：时间窗 + filter；titleOnly 时关键字匹配也在此完成 ──
    const candidates = [...this.getIndex()]
      .sort((a, b) => b.timestamp - a.timestamp) // 最近优先，与旧实现的「最新日期 + 逆序记录」一致
      .filter(e => {
        const ts = e.timestamp || 0
        if (startTs !== undefined && ts < startTs) return false
        if (endTs !== undefined && ts > endTs) return false
        if (options.filter && !options.filter(e as unknown as AgentRecord)) return false
        if (titleOnly && hasKeyword && !e.userTask?.toLowerCase().includes(lowerKeyword)) return false
        return true
      })

    // titleOnly：候选即命中集合，仅需为展示读回前 limit 条完整记录
    if (titleOnly) {
      const totalMatched = candidates.length
      const records = await this.materializeRecords(candidates.slice(0, limit))
      return { records, totalMatched, hasMore: totalMatched > records.length }
    }

    // full：按候选所在日期文件分组，异步逐文件读取，对完整记录做正文关键字匹配
    const candidateIdsByDate = new Map<string, Set<string>>()
    const dateOrder: string[] = []
    for (const e of candidates) {
      let idSet = candidateIdsByDate.get(e.dateStr)
      if (!idSet) {
        idSet = new Set()
        candidateIdsByDate.set(e.dateStr, idSet)
        dateOrder.push(e.dateStr) // candidates 已按时间倒序，首次出现顺序即最新日期优先
      }
      idSet.add(e.id)
    }

    const results: AgentRecord[] = []
    let totalMatched = 0

    const candidateEntries = candidates.filter(e => candidateIdsByDate.has(e.dateStr))
    for (const entry of candidateEntries) {
      const r = await this.readAgentRecordFromDiskAsync(entry.dateStr, entry.id)
      if (!r) continue
      const matchedByKeyword = !hasKeyword || Boolean(
        r.userTask?.toLowerCase().includes(lowerKeyword) ||
          r.finalResult?.toLowerCase().includes(lowerKeyword) ||
          r.steps?.some(s =>
            ((s.type === 'user_task' || s.type === 'user_supplement') &&
              s.content?.toLowerCase().includes(lowerKeyword)) ||
            (s.toolName === 'talk_to_user' &&
              (s.toolArgs as Record<string, unknown>)?.message?.toString().toLowerCase().includes(lowerKeyword))
          )
      )
      if (matchedByKeyword) {
        totalMatched++
        if (results.length < limit) {
          results.push(r)
        }
      }
    }

    return {
      records: results,
      totalMatched,
      hasMore: totalMatched > results.length
    }
  }

  /**
   * 把索引条目还原为完整 AgentRecord，按 dateStr 分组异步读取，保持入参顺序。
   */
  private async materializeRecords(entries: AgentIndexEntry[]): Promise<AgentRecord[]> {
    if (entries.length === 0) return []

    const idsByDate = new Map<string, Set<string>>()
    for (const e of entries) {
      let idSet = idsByDate.get(e.dateStr)
      if (!idSet) {
        idSet = new Set()
        idsByDate.set(e.dateStr, idSet)
      }
      idSet.add(e.id)
    }

    const recordById = new Map<string, AgentRecord>()
    for (const [dateStr, idSet] of idsByDate) {
      for (const id of idSet) {
        const record = await this.readAgentRecordFromDiskAsync(dateStr, id)
        if (record) recordById.set(id, record)
      }
    }

    const out: AgentRecord[] = []
    for (const e of entries) {
      const r = recordById.get(e.id)
      if (r) out.push(r)
    }
    return out
  }

  private parseDateBoundary(value: string | undefined, type: 'start' | 'end'): number | undefined {
    if (!value) return undefined
    const text = value.trim()
    if (!text) return undefined

    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
    if (dateMatch) {
      const [_, y, m, d] = dateMatch
      return this.createLocalDateMs(
        Number(y),
        Number(m),
        Number(d),
        type === 'start' ? 0 : 23,
        type === 'start' ? 0 : 59,
        type === 'start' ? 0 : 59,
        type === 'start' ? 0 : 999
      )
    }

    const hourMatch = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2})$/.exec(text)
    if (hourMatch) {
      const [_, y, m, d, hh] = hourMatch
      return this.createLocalDateMs(
        Number(y),
        Number(m),
        Number(d),
        Number(hh),
        type === 'start' ? 0 : 59,
        type === 'start' ? 0 : 59,
        type === 'start' ? 0 : 999
      )
    }

    const minuteMatch = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text)
    if (minuteMatch) {
      const [_, y, m, d, hh, mm] = minuteMatch
      return this.createLocalDateMs(
        Number(y),
        Number(m),
        Number(d),
        Number(hh),
        Number(mm),
        type === 'start' ? 0 : 59,
        type === 'start' ? 0 : 999
      )
    }

    // ISO 时间仅接受带时区的格式，避免环境差异导致的歧义
    if (/T/.test(text) && (/[zZ]$/.test(text) || /[+-]\d{2}:\d{2}$/.test(text))) {
      const parsed = new Date(text)
      return Number.isNaN(parsed.getTime()) ? undefined : parsed.getTime()
    }

    return undefined
  }

  private createLocalDateMs(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    millisecond: number
  ): number | undefined {
    const date = new Date(year, month - 1, day, hour, minute, second, millisecond)
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day ||
      date.getHours() !== hour ||
      date.getMinutes() !== minute ||
      date.getSeconds() !== second ||
      date.getMilliseconds() !== millisecond
    ) {
      return undefined
    }
    return date.getTime()
  }

  // ==================== Token 用量统计 ====================

  /**
   * 从索引聚合 Token 用量统计（纯内存操作，零磁盘 IO）
   */
  getTokenUsageStats(): TokenUsageStatsResult {
    // 合并主索引 + watch 索引：watch 内心独白同样消耗 token，统计必须计入，否则漏算成本
    const index = [...this.getIndex(), ...this.getIndexFor(this.watchStore)]
    const now = new Date()
    const todayStr = this.getDateString()
    const day7Ago = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).getTime()
    const day30Ago = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).getTime()

    const emptyPeriod = (): TokenUsagePeriodStats => ({
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      cache_hit_tokens: 0, cache_miss_tokens: 0, taskCount: 0
    })

    const total = emptyPeriod()
    const today = emptyPeriod()
    const last7Days = emptyPeriod()
    const last30Days = emptyPeriod()
    const dailyMap = new Map<string, TokenUsagePeriodStats>()

    for (const entry of index) {
      const usage = entry.tokenUsage
      if (!usage) continue

      const addTo = (target: TokenUsagePeriodStats) => {
        target.prompt_tokens += usage.prompt_tokens
        target.completion_tokens += usage.completion_tokens
        target.total_tokens += usage.total_tokens
        target.cache_hit_tokens += usage.cache_hit_tokens || 0
        target.cache_miss_tokens += usage.cache_miss_tokens || 0
        target.taskCount++
      }

      addTo(total)

      if (entry.dateStr === todayStr) {
        addTo(today)
      }
      if (entry.timestamp >= day7Ago) {
        addTo(last7Days)
      }
      if (entry.timestamp >= day30Ago) {
        addTo(last30Days)

        // 按日聚合（仅近 30 天）
        if (!dailyMap.has(entry.dateStr)) {
          dailyMap.set(entry.dateStr, emptyPeriod())
        }
        const dayStats = dailyMap.get(entry.dateStr)!
        addTo(dayStats)
      }
    }

    const daily = Array.from(dailyMap.entries())
      .map(([date, stats]) => ({ date, ...stats }))
      .sort((a, b) => b.date.localeCompare(a.date))

    return { total, today, last7Days, last30Days, daily }
  }

  // ==================== 导出/导入 ====================

  /**
   * 获取数据目录路径
   */
  getDataPath(): string {
    return app.getPath('userData')
  }

  /**
   * 获取历史目录路径
   */
  getHistoryPath(): string {
    return this.historyDir
  }

  /**
   * 导出到文件夹
   */
  exportToFolder(exportPath: string, configData: object, hostProfiles?: HostProfileData[], options?: {
    includeSshPasswords?: boolean
    includeApiKeys?: boolean
  }): { success: boolean; files: string[]; error?: string } {
    try {
      const files: string[] = []
      const opts = { includeSshPasswords: false, includeApiKeys: false, ...options }

      // 确保目录存在
      if (!fs.existsSync(exportPath)) {
        fs.mkdirSync(exportPath, { recursive: true })
      }

      // 1. 导出 SSH 连接配置（可选去除密码）
      const config = configData as {
        sshSessions?: Array<{ password?: string; passphrase?: string; [key: string]: unknown }>
        aiProfiles?: Array<{ apiKey?: string; [key: string]: unknown }>
        [key: string]: unknown
      }
      
      if (config.sshSessions && config.sshSessions.length > 0) {
        const sshData = config.sshSessions.map(session => {
          if (opts.includeSshPasswords) return session
          // 移除敏感字段
          const { password: _pw, passphrase: _pp, ...safe } = session
          return safe
        })
        const sshPath = path.join(exportPath, 'ssh-sessions.json')
        fs.writeFileSync(sshPath, JSON.stringify(sshData, null, 2), 'utf-8')
        files.push('ssh-sessions.json')
      }

      // 2. 导出 AI 配置（可选去除 API Key）
      if (config.aiProfiles && config.aiProfiles.length > 0) {
        const aiData = config.aiProfiles.map(profile => {
          if (opts.includeApiKeys) return profile
          const { apiKey, ...safe } = profile
          return { ...safe, apiKey: apiKey ? '***' : '' }
        })
        const aiPath = path.join(exportPath, 'ai-profiles.json')
        fs.writeFileSync(aiPath, JSON.stringify(aiData, null, 2), 'utf-8')
        files.push('ai-profiles.json')
      }

      // 3. 导出终端设置和主题
      const settingsData = {
        theme: config.theme,
        terminalSettings: config.terminalSettings,
        proxySettings: config.proxySettings,
        knowledgeSettings: config.knowledgeSettings
      }
      const settingsPath = path.join(exportPath, 'settings.json')
      fs.writeFileSync(settingsPath, JSON.stringify(settingsData, null, 2), 'utf-8')
      files.push('settings.json')

      // 4. 导出主机档案
      if (hostProfiles && hostProfiles.length > 0) {
        const hostPath = path.join(exportPath, 'host-profiles.json')
        fs.writeFileSync(hostPath, JSON.stringify(hostProfiles, null, 2), 'utf-8')
        files.push('host-profiles.json')
      }

      // 5. 导出聊天记录
      const chatRecords = this.getChatRecords()
      if (chatRecords.length > 0) {
        const chatPath = path.join(exportPath, 'chat-history.json')
        fs.writeFileSync(chatPath, JSON.stringify(chatRecords, null, 2), 'utf-8')
        files.push('chat-history.json')
      }

      // 6. 导出 Agent 记录
      const agentRecords = this.getAgentRecords()
      if (agentRecords.length > 0) {
        const agentPath = path.join(exportPath, 'agent-history.json')
        fs.writeFileSync(agentPath, JSON.stringify(agentRecords, null, 2), 'utf-8')
        files.push('agent-history.json')
      }

      // 7. 导出用户技能目录
      const skillsDir = path.join(app.getPath('userData'), 'skills')
      if (fs.existsSync(skillsDir)) {
        const skillsExportDir = path.join(exportPath, 'skills')
        this.copyDirectory(skillsDir, skillsExportDir)
        files.push('skills/')
      }

      // 8. 写入说明文件
      const readme = `# 旗鱼备份
导出时间: ${new Date().toLocaleString()}

## 文件说明
- ssh-sessions.json  - SSH 连接配置${opts.includeSshPasswords ? '' : '（不含密码）'}
- ai-profiles.json   - AI 配置${opts.includeApiKeys ? '' : '（不含 API Key）'}
- settings.json      - 终端设置、主题、代理
- host-profiles.json - 主机档案（含记忆）
- chat-history.json  - 聊天记录
- agent-history.json - Agent 任务记录
- skills/            - 用户技能文件

## 导入方式
1. 在设置 > 数据管理中导入整个文件夹
2. 或手动复制需要的文件到新设备的数据目录
`
      const readmePath = path.join(exportPath, 'README.txt')
      fs.writeFileSync(readmePath, readme, 'utf-8')
      files.push('README.txt')

      return { success: true, files }
    } catch (e) {
      return { success: false, files: [], error: e instanceof Error ? e.message : '导出失败' }
    }
  }

  /**
   * 从文件夹导入
   */
  importFromFolder(importPath: string): { 
    success: boolean
    imported: string[]
    error?: string 
    config?: Partial<{
      sshSessions: unknown[]
      aiProfiles: unknown[]
      theme: string
      terminalSettings: unknown
      proxySettings: unknown
    }>
    hostProfiles?: HostProfileData[]
  } {
    try {
      const imported: string[] = []
      const config: Record<string, unknown> = {}
      let hostProfiles: HostProfileData[] | undefined

      // 读取各个文件
      const sshPath = path.join(importPath, 'ssh-sessions.json')
      if (fs.existsSync(sshPath)) {
        config.sshSessions = JSON.parse(fs.readFileSync(sshPath, 'utf-8'))
        imported.push('SSH 连接配置')
      }

      const aiPath = path.join(importPath, 'ai-profiles.json')
      if (fs.existsSync(aiPath)) {
        config.aiProfiles = JSON.parse(fs.readFileSync(aiPath, 'utf-8'))
        imported.push('AI 配置')
      }

      const settingsPath = path.join(importPath, 'settings.json')
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
        Object.assign(config, settings)
        imported.push('终端设置')
      }

      const hostPath = path.join(importPath, 'host-profiles.json')
      if (fs.existsSync(hostPath)) {
        hostProfiles = JSON.parse(fs.readFileSync(hostPath, 'utf-8'))
        imported.push('主机档案')
      }

      const chatPath = path.join(importPath, 'chat-history.json')
      if (fs.existsSync(chatPath)) {
        const chatRecords = JSON.parse(fs.readFileSync(chatPath, 'utf-8')) as ChatRecord[]
        this.saveChatRecords(chatRecords)
        imported.push('聊天记录')
      }

      const agentPath = path.join(importPath, 'agent-history.json')
      if (fs.existsSync(agentPath)) {
        const agentRecords = JSON.parse(fs.readFileSync(agentPath, 'utf-8')) as AgentRecord[]
        for (const record of agentRecords) {
          this.saveAgentRecord(record)
        }
        imported.push('Agent 记录')
      }

      // 导入用户技能
      const skillsImportDir = path.join(importPath, 'skills')
      if (fs.existsSync(skillsImportDir)) {
        const skillsDir = path.join(app.getPath('userData'), 'skills')
        this.mergeDirectory(skillsImportDir, skillsDir)
        imported.push('用户技能')
      }

      return { success: true, imported, config, hostProfiles }
    } catch (e) {
      return { success: false, imported: [], error: e instanceof Error ? e.message : '导入失败' }
    }
  }

  /**
   * 清理指定天数之前的历史记录
   * @param daysToKeep 保留最近几天的记录，0 表示清空全部
   */
  cleanupOldRecords(daysToKeep: number = 90): { chatDeleted: number; agentDeleted: number } {
    let chatDeleted = 0
    let agentDeleted = 0

    // daysToKeep = 0 表示清空全部
    if (daysToKeep === 0) {
      // 清空所有聊天记录
      const chatFiles = fs.readdirSync(this.chatDir).filter(f => f.endsWith('.json'))
      for (const file of chatFiles) {
        fs.unlinkSync(path.join(this.chatDir, file))
        chatDeleted++
      }

      // 清空所有 Agent 记录（会话文件 + 旧日文件 + 日期目录），主树 + watch 树
      for (const dir of [this.agentDir, this.watchDir]) {
        if (!fs.existsSync(dir)) continue
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const entryPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            fs.rmSync(entryPath, { recursive: true, force: true })
            agentDeleted++
          } else if (entry.isFile() && entry.name.endsWith('.json')) {
            fs.unlinkSync(entryPath)
            agentDeleted++
          }
        }
      }
    } else {
      // 按日期保留
      const cutoffDate = new Date()
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep)
      const cutoffStr = this.getDateString(cutoffDate.getTime())

      // 清理聊天记录
      const chatFiles = fs.readdirSync(this.chatDir).filter(f => f.endsWith('.json'))
      for (const file of chatFiles) {
        const dateStr = file.replace('.json', '')
        if (dateStr < cutoffStr) {
          fs.unlinkSync(path.join(this.chatDir, file))
          chatDeleted++
        }
      }

      // 清理 Agent 记录（主树 + watch 树）
      for (const dir of [this.agentDir, this.watchDir]) {
        for (const dateStr of listAgentDateDirs(dir)) {
          if (dateStr < cutoffStr) {
            fs.rmSync(path.join(dir, dateStr), { recursive: true, force: true })
            agentDeleted++
          }
        }
        for (const file of listLegacyAgentDayFiles(dir)) {
          const dateStr = file.replace('.json', '')
          if (dateStr < cutoffStr) {
            fs.unlinkSync(path.join(dir, file))
            agentDeleted++
          }
        }
      }
    }

    if (chatDeleted > 0 || agentDeleted > 0) {
      this.rebuildAgentIndex()
    }

    return { chatDeleted, agentDeleted }
  }

  /**
   * 获取存储统计信息
   */
  getStorageStats(): {
    chatFiles: number
    agentFiles: number
    agentSessions: number
    totalSize: number
    oldestRecord?: string
    newestRecord?: string
  } {
    const chatFiles = fs.readdirSync(this.chatDir).filter(f => f.endsWith('.json')).sort()
    const agentStats = collectAgentStorageStats(this.agentDir)
    const watchStats = collectAgentStorageStats(this.watchDir)

    let totalSize = agentStats.totalSize + watchStats.totalSize
    for (const file of chatFiles) {
      totalSize += fs.statSync(path.join(this.chatDir, file)).size
    }

    const agentDateLabels = new Set([...agentStats.dateLabels, ...watchStats.dateLabels])
    const allDates = [...new Set([
      ...chatFiles.map(f => f.replace('.json', '')),
      ...agentDateLabels,
    ])].sort()

    return {
      chatFiles: chatFiles.length,
      // 有记录的天数（v5 起按会话单文件存储，不能再用文件数代替天数）
      agentFiles: agentDateLabels.size,
      agentSessions: this.getIndex().length + this.getIndexFor(this.watchStore).length,
      totalSize,
      oldestRecord: allDates[0],
      newestRecord: allDates[allDates.length - 1]
    }
  }
}

