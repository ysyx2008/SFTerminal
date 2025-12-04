import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

// ==================== 类型定义 ====================

export interface ChatRecord {
  id: string
  timestamp: number
  terminalId: string
  terminalType: 'local' | 'ssh'
  sshHost?: string
  role: 'user' | 'assistant'
  content: string
}

export interface AgentStepRecord {
  id: string
  type: string
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: string
  timestamp: number
}

export interface AgentRecord {
  id: string
  timestamp: number
  terminalId: string
  terminalType: 'local' | 'ssh'
  sshHost?: string
  userTask: string
  steps: AgentStepRecord[]
  finalResult?: string
  duration: number
  status: 'completed' | 'failed' | 'aborted'
}

export interface ExportData {
  version: string
  exportTime: number
  config: object
  history: {
    chat: ChatRecord[]
    agent: AgentRecord[]
  }
}

// ==================== 历史记录服务 ====================

export class HistoryService {
  private historyDir: string
  private chatDir: string
  private agentDir: string

  constructor() {
    // 获取用户数据目录
    const userDataPath = app.getPath('userData')
    this.historyDir = path.join(userDataPath, 'history')
    this.chatDir = path.join(this.historyDir, 'chat')
    this.agentDir = path.join(this.historyDir, 'agent')

    // 确保目录存在
    this.ensureDirectories()
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
      console.error(`读取历史文件失败: ${filePath}`, e)
    }
    return []
  }

  /**
   * 写入 JSON 文件
   */
  private writeJsonFile<T>(filePath: string, data: T[]): void {
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (e) {
      console.error(`写入历史文件失败: ${filePath}`, e)
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
    for (const [dateStr, dateRecords] of grouped) {
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
   * 保存 Agent 记录
   */
  saveAgentRecord(record: AgentRecord): void {
    const dateStr = this.getDateString(record.timestamp)
    const filePath = this.getAgentFilePath(dateStr)
    const records = this.readJsonFile<AgentRecord>(filePath)
    records.push(record)
    this.writeJsonFile(filePath, records)
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
      records.push(...this.readJsonFile<AgentRecord>(filePath))
    }

    return records.sort((a, b) => a.timestamp - b.timestamp)
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
   * 导出所有数据
   */
  exportData(configData: object): ExportData {
    return {
      version: '1.0',
      exportTime: Date.now(),
      config: configData,
      history: {
        chat: this.getChatRecords(),
        agent: this.getAgentRecords()
      }
    }
  }

  /**
   * 导入数据
   */
  importData(data: ExportData): { success: boolean; error?: string } {
    try {
      // 验证版本
      if (!data.version || !data.exportTime) {
        return { success: false, error: '无效的备份文件格式' }
      }

      // 导入聊天记录
      if (data.history?.chat?.length > 0) {
        this.saveChatRecords(data.history.chat)
      }

      // 导入 Agent 记录
      if (data.history?.agent?.length > 0) {
        for (const record of data.history.agent) {
          this.saveAgentRecord(record)
        }
      }

      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : '导入失败' }
    }
  }

  /**
   * 清理指定天数之前的历史记录
   */
  cleanupOldRecords(daysToKeep: number = 90): { chatDeleted: number; agentDeleted: number } {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep)
    const cutoffStr = this.getDateString(cutoffDate.getTime())

    let chatDeleted = 0
    let agentDeleted = 0

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

