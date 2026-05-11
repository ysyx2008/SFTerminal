import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { createLogger } from '../utils/logger'
import { normalizeAgentRecord } from '../utils/normalize'

const log = createLogger('History')

// ==================== 类型定义 ====================

// 从共享类型导入并重新导出
import type { TerminalType, AgentRecord, TokenUsage } from '@shared/types'
export type { AgentStepRecord, AgentRecord } from '@shared/types'

export interface ChatRecord {
  id: string
  timestamp: number
  terminalId: string
  terminalType: TerminalType
  sshHost?: string
  role: 'user' | 'assistant'
  content: string
}

/** 索引条目：每条 AgentRecord 的轻量摘要，用于排序和过滤，避免读取完整日期文件 */
interface AgentIndexEntry {
  id: string
  timestamp: number
  duration: number
  dateStr: string
  userTask: string
  terminalType: TerminalType
  sshHost?: string
  status: 'completed' | 'failed' | 'aborted'
  tokenUsage?: TokenUsage
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
  private _indexCache: AgentIndexEntry[] | null = null

  constructor() {
    // 获取用户数据目录
    const userDataPath = app.getPath('userData')
    this.historyDir = path.join(userDataPath, 'history')
    this.chatDir = path.join(this.historyDir, 'chat')
    this.agentDir = path.join(this.historyDir, 'agent')

    // 确保目录存在
    this.ensureDirectories()
  }

  private get indexPath(): string {
    return path.join(this.historyDir, 'agent-index.json')
  }

  /**
   * 确保历史记录目录存在
   */
  private ensureDirectories(): void {
    const dirs = [this.historyDir, this.chatDir, this.agentDir]
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
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

  /**
   * 获取指定日期的 Agent 记录文件路径
   */
  private getAgentFilePath(dateStr: string): string {
    return path.join(this.agentDir, `${dateStr}.json`)
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

  private readAgentRecords(filePath: string): AgentRecord[] {
    return this.readJsonFile<AgentRecord>(filePath).map(normalizeAgentRecord)
  }

  // ==================== Agent 索引管理 ====================

  private getIndex(): AgentIndexEntry[] {
    if (this._indexCache) return this._indexCache

    try {
      if (fs.existsSync(this.indexPath)) {
        const content = fs.readFileSync(this.indexPath, 'utf-8')
        this._indexCache = JSON.parse(content) as AgentIndexEntry[]
        return this._indexCache
      }
    } catch (e) {
      log.warn('读取 Agent 索引失败，将重建:', e)
    }

    return this.rebuildIndex()
  }

  private writeIndex(entries: AgentIndexEntry[]): void {
    this._indexCache = entries
    try {
      fs.writeFileSync(this.indexPath, JSON.stringify(entries), 'utf-8')
    } catch (e) {
      log.error('写入 Agent 索引失败:', e)
    }
  }

  /** 从所有日期文件重建索引（首次升级或索引损坏时触发） */
  private rebuildIndex(): AgentIndexEntry[] {
    const files = fs.readdirSync(this.agentDir).filter(f => f.endsWith('.json')).sort()
    const entries: AgentIndexEntry[] = []

    for (const file of files) {
      const dateStr = file.replace('.json', '')
      const filePath = path.join(this.agentDir, file)
      const records = this.readAgentRecords(filePath)
      for (const r of records) {
        entries.push(this.toIndexEntry(r, dateStr))
      }
    }

    this.writeIndex(entries)
    log.info(`Agent 索引已重建，共 ${entries.length} 条记录`)
    return entries
  }

  private toIndexEntry(record: AgentRecord, dateStr: string): AgentIndexEntry {
    const entry: AgentIndexEntry = {
      id: record.id,
      timestamp: record.timestamp,
      duration: record.duration,
      dateStr,
      userTask: record.userTask,
      terminalType: record.terminalType,
      sshHost: record.sshHost,
      status: record.status,
    }
    if (record.tokenUsage) {
      entry.tokenUsage = record.tokenUsage
    }
    return entry
  }

  private updateIndexEntry(record: AgentRecord): void {
    const entries = this.getIndex()
    const dateStr = this.getDateString(record.timestamp)
    const entry = this.toIndexEntry(record, dateStr)

    const idx = entries.findIndex(e => e.id === record.id)
    if (idx !== -1) {
      entries[idx] = entry
    } else {
      entries.push(entry)
    }

    this.writeIndex(entries)
  }

  /**
   * 写入 JSON 文件
   */
  private writeJsonFile<T>(filePath: string, data: T[]): void {
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
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
    const dateStr = this.getDateString(record.timestamp)
    const filePath = this.getAgentFilePath(dateStr)
    const records = this.readAgentRecords(filePath)
    
    // 查找是否存在相同 id 的记录
    const existingIndex = records.findIndex(r => r.id === record.id)
    if (existingIndex !== -1) {
      records[existingIndex] = record
    } else {
      records.push(record)
    }
    
    this.writeJsonFile(filePath, records)
    this.updateIndexEntry(record)
  }

  /**
   * 获取指定日期范围的 Agent 记录
   */
  getAgentRecords(startDate?: string, endDate?: string): AgentRecord[] {
    const files = fs.readdirSync(this.agentDir).filter(f => f.endsWith('.json')).sort()
    const records: AgentRecord[] = []

    for (const file of files) {
      const dateStr = file.replace('.json', '')
      if (startDate && dateStr < startDate) continue
      if (endDate && dateStr > endDate) continue

      const filePath = path.join(this.agentDir, file)
      records.push(...this.readAgentRecords(filePath))
    }

    return records.sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * 按 ID 查找 Agent 记录（跨日期文件查找）
   */
  getAgentRecordById(id: string): AgentRecord | undefined {
    const files = fs.readdirSync(this.agentDir).filter(f => f.endsWith('.json')).sort().reverse()
    for (const file of files) {
      const filePath = path.join(this.agentDir, file)
      const records = this.readAgentRecords(filePath)
      const found = records.find(r => r.id === id)
      if (found) return found
    }
    return undefined
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
    const neededIds = new Set(candidates.map(e => e.id))
    const dateStrs = new Set(candidates.map(e => e.dateStr))
    const results: AgentRecord[] = []

    for (const dateStr of dateStrs) {
      const filePath = this.getAgentFilePath(dateStr)
      if (!fs.existsSync(filePath)) continue
      const records = this.readAgentRecords(filePath)
      for (const r of records) {
        if (neededIds.has(r.id)) results.push(r)
      }
    }

    return results.sort((a, b) => (b.timestamp + b.duration) - (a.timestamp + a.duration))
  }

  /**
   * 关键字搜索 Agent 历史记录
   * 搜索范围：userTask、finalResult、以及过程中用户追加的消息（user_task / user_supplement steps）
   */
  searchAgentRecords(keyword: string, limit: number = 10): AgentRecord[] {
    return this.searchAgentRecordsAdvanced({ keyword, limit }).records
  }

  /**
   * 高级搜索 Agent 历史记录
   * 支持关键字搜索、时间范围过滤，以及 hasMore 提示
   */
  searchAgentRecordsAdvanced(options: SearchAgentRecordsOptions): SearchAgentRecordsResult {
    const keyword = options.keyword?.trim() ?? ''
    if (!keyword && !options.startDate && !options.endDate) {
      return { records: [], totalMatched: 0, hasMore: false }
    }

    const lowerKeyword = keyword.toLowerCase()
    const hasKeyword = lowerKeyword.length > 0
    const limit = Math.max(1, options.limit ?? 10)
    const files = fs.readdirSync(this.agentDir).filter(f => f.endsWith('.json')).sort().reverse()
    const results: AgentRecord[] = []
    let totalMatched = 0

    const startTs = this.parseDateBoundary(options.startDate, 'start')
    const endTs = this.parseDateBoundary(options.endDate, 'end')

    for (const file of files) {
      const filePath = path.join(this.agentDir, file)
      const records = this.readAgentRecords(filePath)
      for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i]
        const ts = r.timestamp || 0
        if (startTs !== undefined && ts < startTs) continue
        if (endTs !== undefined && ts > endTs) continue

        const matchedByKeyword = hasKeyword
          ? (r.userTask?.toLowerCase().includes(lowerKeyword) ||
              r.finalResult?.toLowerCase().includes(lowerKeyword) ||
              r.steps?.some(s =>
                ((s.type === 'user_task' || s.type === 'user_supplement') &&
                  s.content?.toLowerCase().includes(lowerKeyword)) ||
                (s.toolName === 'talk_to_user' &&
                  (s.toolArgs as Record<string, unknown>)?.message?.toString().toLowerCase().includes(lowerKeyword))
              ))
          : true
        const passesRecordFilter = !options.filter || options.filter(r)
        if (matchedByKeyword && passesRecordFilter) {
          totalMatched++
          if (results.length < limit) {
            results.push(r)
          }
        }
      }
    }

    return {
      records: results,
      totalMatched,
      hasMore: totalMatched > results.length
    }
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
    const index = this.getIndex()
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

      // 清空所有 Agent 记录
      const agentFiles = fs.readdirSync(this.agentDir).filter(f => f.endsWith('.json'))
      for (const file of agentFiles) {
        fs.unlinkSync(path.join(this.agentDir, file))
        agentDeleted++
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

      // 清理 Agent 记录
      const agentFiles = fs.readdirSync(this.agentDir).filter(f => f.endsWith('.json'))
      for (const file of agentFiles) {
        const dateStr = file.replace('.json', '')
        if (dateStr < cutoffStr) {
          fs.unlinkSync(path.join(this.agentDir, file))
          agentDeleted++
        }
      }
    }

    if (chatDeleted > 0 || agentDeleted > 0) {
      this.rebuildIndex()
    }

    return { chatDeleted, agentDeleted }
  }

  /**
   * 获取存储统计信息
   */
  getStorageStats(): {
    chatFiles: number
    agentFiles: number
    totalSize: number
    oldestRecord?: string
    newestRecord?: string
  } {
    const chatFiles = fs.readdirSync(this.chatDir).filter(f => f.endsWith('.json')).sort()
    const agentFiles = fs.readdirSync(this.agentDir).filter(f => f.endsWith('.json')).sort()

    let totalSize = 0
    for (const file of chatFiles) {
      totalSize += fs.statSync(path.join(this.chatDir, file)).size
    }
    for (const file of agentFiles) {
      totalSize += fs.statSync(path.join(this.agentDir, file)).size
    }

    const allFiles = [...chatFiles, ...agentFiles].sort()

    return {
      chatFiles: chatFiles.length,
      agentFiles: agentFiles.length,
      totalSize,
      oldestRecord: allFiles[0]?.replace('.json', ''),
      newestRecord: allFiles[allFiles.length - 1]?.replace('.json', '')
    }
  }
}

