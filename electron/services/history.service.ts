import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { createLogger } from '../utils/logger'
import { writeFileAtomic } from '../utils/atomic-write'
import { getDateString } from './history/date-util'
import { AgentRecordStore, type SearchAgentRecordsOptions, type SearchAgentRecordsResult } from './history/agent-record-store'

const log = createLogger('History')

// ==================== 类型定义 ====================

// 从共享类型导入并重新导出
import type { TerminalType, AgentRecord, AgentHistorySummary } from '@shared/types'
export type { AgentStepRecord, AgentRecord, AgentHistorySummary } from '@shared/types'
// 搜索入参/结果由 AgentRecordStore 定义，这里 re-export 保持旧 import 路径兼容
export type { SearchAgentRecordsOptions, SearchAgentRecordsResult } from './history/agent-record-store'

export interface ChatRecord {
  id: string
  timestamp: number
  terminalId: string
  terminalType: TerminalType
  sshHost?: string
  role: 'user' | 'assistant'
  content: string
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

/**
 * HistoryService —— 聊天记录 + Token 统计 + 数据备份/清理 的运维服务
 *
 * 重构后（docs/conversation-refactor-design.md §4.3）：会话记录（AgentRecord）的存储 + 索引
 * 已抽到 `AgentRecordStore`（会话域聚合根的真实存储）。本类**组合**它，并保留以下非会话域职责：
 * - 聊天记录（ChatRecord）：独立的遗留聊天历史，非会话域。
 * - Token 用量统计：跨主树 + watch 树的索引聚合（读 `agentRecordStore.getAllIndexEntries()`）。
 * - 导出/导入备份：把 SSH/AI 配置 + 主机档案 + 聊天 + Agent 记录 + 技能打包。
 * - 清理 + 存储统计：按日期清旧记录、汇报磁盘占用。
 *
 * 对外的 AgentRecord 相关方法（saveAgentRecord 等）**保留为委派转发**，向后兼容现有调用方
 * （main.ts IPC handler / AgentService / Agent / 前端 IPC）。新代码应优先走 ConversationManager
 * 的读侧接缝；写侧目前仍经此处转发，完整所有权反转见重构阶段 4B。
 */
export class HistoryService {
  private historyDir: string
  private chatDir: string
  /** 会话记录存储聚合（AgentRecord 的真实存储 + 索引所有者） */
  private agentRecordStore: AgentRecordStore

  constructor() {
    const userDataPath = app.getPath('userData')
    this.historyDir = path.join(userDataPath, 'history')
    this.chatDir = path.join(this.historyDir, 'chat')

    // 会话记录存储（含 agent/watch 两棵历史树 + 索引 + 图片外化）。它自建 history/agent/watch/images 目录。
    this.agentRecordStore = new AgentRecordStore(this.historyDir)

    this.ensureChatDir()
  }

  /** 暴露会话存储聚合，供 ConversationManager/ConversationStore 装配为读侧接缝。 */
  getAgentRecordStore(): AgentRecordStore {
    return this.agentRecordStore
  }

  private ensureChatDir(): void {
    if (!fs.existsSync(this.chatDir)) {
      fs.mkdirSync(this.chatDir, { recursive: true })
    }
  }

  // ==================== 聊天记录（ChatRecord，非会话域） ====================

  private getChatFilePath(dateStr: string): string {
    return path.join(this.chatDir, `${dateStr}.json`)
  }

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

  private writeJsonFile<T>(filePath: string, data: T[]): void {
    try {
      writeFileAtomic(filePath, JSON.stringify(data, null, 2))
    } catch (e) {
      log.error(`写入历史文件失败: ${filePath}`, e)
    }
  }

  /**
   * 保存聊天记录
   */
  saveChatRecord(record: ChatRecord): void {
    const dateStr = getDateString(record.timestamp)
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
      const dateStr = getDateString(record.timestamp)
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

  // ==================== Agent 记录（委派 AgentRecordStore，向后兼容） ====================

  /** 保存 Agent 记录（委派 store）。 */
  saveAgentRecord(record: AgentRecord): void {
    this.agentRecordStore.saveAgentRecord(record)
  }

  /** 保存（或更新）产出物面板清单到指定记录（委派 store）。 */
  saveArtifacts(recordId: string, artifacts: import('@shared/types').CanvasArtifact[]): void {
    this.agentRecordStore.saveArtifacts(recordId, artifacts)
  }

  /** 按 ID 查找 Agent 记录（委派 store）。 */
  getAgentRecordById(id: string): AgentRecord | undefined {
    return this.agentRecordStore.getAgentRecordById(id)
  }

  /** 按 ID 删除单条 Agent 记录（委派 store）。 */
  deleteAgentRecord(id: string): boolean {
    return this.agentRecordStore.deleteAgentRecord(id)
  }

  /** 获取指定日期范围的 Agent 记录（委派 store）。 */
  getAgentRecords(startDate?: string, endDate?: string): AgentRecord[] {
    return this.agentRecordStore.getAgentRecords(startDate, endDate)
  }

  /** 最近的 N 条 Agent 记录（委派 store）。 */
  getRecentAgentRecords(limit: number = 5, filter?: (r: AgentRecord) => boolean): AgentRecord[] {
    return this.agentRecordStore.getRecentAgentRecords(limit, filter)
  }

  /** 某个 agentKey 最近一条会话（委派 store）。 */
  getLatestRecordByAgentKey(agentKey: string): AgentRecord | undefined {
    return this.agentRecordStore.getLatestRecordByAgentKey(agentKey)
  }

  /** 某个 agentKey 最近的 N 条会话（委派 store）。 */
  getRecentRecordsByAgentKey(agentKey: string, limit: number = 10): AgentRecord[] {
    return this.agentRecordStore.getRecentRecordsByAgentKey(agentKey, limit)
  }

  /** 最近 N 条 watch 执行记录（委派 store）。 */
  getRecentWatchRecords(limit: number = 20, filter?: (r: AgentRecord) => boolean): AgentRecord[] {
    return this.agentRecordStore.getRecentWatchRecords(limit, filter)
  }

  /** Agent 历史轻量摘要（委派 store）。 */
  listAgentHistorySummaries(excludeWakeup?: boolean): AgentHistorySummary[] {
    return this.agentRecordStore.listAgentHistorySummaries(excludeWakeup)
  }

  /** 关键字搜索 Agent 历史记录（委派 store）。 */
  async searchAgentRecords(keyword: string, limit: number = 10): Promise<AgentRecord[]> {
    return this.agentRecordStore.searchAgentRecords(keyword, limit)
  }

  /** 高级搜索 Agent 历史记录（委派 store）。 */
  async searchAgentRecordsAdvanced(options: SearchAgentRecordsOptions): Promise<SearchAgentRecordsResult> {
    return this.agentRecordStore.searchAgentRecordsAdvanced(options)
  }

  /** 从磁盘重建全部索引（主 + watch，委派 store）。 */
  rebuildAgentIndex(): void {
    this.agentRecordStore.rebuildAgentIndex()
  }

  // ==================== Token 用量统计（读 store 索引聚合） ====================

  /**
   * 从索引聚合 Token 用量统计（纯内存操作，零磁盘 IO）
   */
  getTokenUsageStats(): TokenUsageStatsResult {
    // 合并主索引 + watch 索引：watch 内心独白同样消耗 token，统计必须计入，否则漏算成本
    const index = this.agentRecordStore.getAllIndexEntries()
    const now = new Date()
    const todayStr = getDateString()
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

  // ==================== 清理 + 存储统计 ====================

  /**
   * 清理指定天数之前的历史记录
   * @param daysToKeep 保留最近几天的记录，0 表示清空全部
   */
  cleanupOldRecords(daysToKeep: number = 90): { chatDeleted: number; agentDeleted: number } {
    let chatDeleted = 0

    // 聊天记录清理（本类职责）
    if (daysToKeep === 0) {
      const chatFiles = fs.readdirSync(this.chatDir).filter(f => f.endsWith('.json'))
      for (const file of chatFiles) {
        fs.unlinkSync(path.join(this.chatDir, file))
        chatDeleted++
      }
    } else {
      const cutoffDate = new Date()
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep)
      const cutoffStr = getDateString(cutoffDate.getTime())

      const chatFiles = fs.readdirSync(this.chatDir).filter(f => f.endsWith('.json'))
      for (const file of chatFiles) {
        const dateStr = file.replace('.json', '')
        if (dateStr < cutoffStr) {
          fs.unlinkSync(path.join(this.chatDir, file))
          chatDeleted++
        }
      }
    }

    // Agent 记录清理（委派 store：主树 + watch 树的会话文件 + 旧日文件 + 日期目录）
    const agentDeleted = this.agentRecordStore.cleanupOldAgentRecords(daysToKeep)

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
    const { agentStats, watchStats } = this.agentRecordStore.getStorageStatsForBoth()

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
      agentSessions: this.agentRecordStore.totalSessionCount,
      totalSize,
      oldestRecord: allDates[0],
      newestRecord: allDates[allDates.length - 1]
    }
  }
}
