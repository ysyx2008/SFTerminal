/**
 * 任务记忆存储服务
 * 实现多层次上下文管理：L1 总结 / L2 摘要 / L3 完整步骤
 */

import type { AiMessage } from '../ai.service'
import type { AgentStep, TaskMemory, TaskDigest, TaskSummary, RelatedTaskDigest } from './types'
import type { ToolMeta } from './tools'

/**
 * 调用方注入的 ToolMeta 查询函数（按工具名查 _meta）。
 * 真实运行时由 agent.ts 提供 `(name) => getMetaByName(this.getAvailableTools(), name)`。
 * 不传入时降级为"返回 undefined"——所有 metadata 检查都拿到 undefined，回到行为兜底。
 */
export type LookupToolMeta = (toolName: string) => ToolMeta | undefined

const NO_LOOKUP: LookupToolMeta = () => undefined

/**
 * 格式化任务时间戳（对齐 AI 消息包体中的时间格式，如文件列表/待办截止时间）。
 * 使用 new Date(ts).toLocaleString() 默认输出，含年月日时分秒。
 */
function formatTaskTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

/**
 * 从文本中提取关键词
 * 用于语义匹配
 */
function extractKeywords(text: string): string[] {
  const keywords: string[] = []
  
  // 常见服务/工具名
  const servicePatterns = /\b(nginx|apache|mysql|mariadb|postgresql|postgres|redis|mongodb|docker|kubernetes|k8s|systemctl|systemd|apt|yum|dnf|npm|yarn|pnpm|pip|python|node|java|go|rust|git|ssh|scp|rsync|curl|wget|grep|awk|sed|tar|zip|unzip|vim|nano|cat|less|more|head|tail|ls|cd|pwd|mkdir|rm|cp|mv|chmod|chown|ps|top|htop|kill|df|du|free|ifconfig|ip|netstat|ss|ping|traceroute|nslookup|dig|cron|crontab|journalctl|dmesg|ufw|iptables|firewalld|certbot|openssl|pm2|supervisor|gunicorn|uwsgi|flask|django|express|react|vue|angular|webpack|vite|eslint|prettier|jest|mocha)\b/gi
  const serviceMatches = text.match(servicePatterns)
  if (serviceMatches) {
    keywords.push(...serviceMatches.map(s => s.toLowerCase()))
  }
  
  // 文件路径
  const pathPatterns = /(?:\/[\w.-]+)+/g
  const pathMatches = text.match(pathPatterns)
  if (pathMatches) {
    keywords.push(...pathMatches)
  }
  
  // 端口号（常见端口）
  const portPatterns = /\b(80|443|22|21|3000|3306|5432|6379|8080|8000|8443|9000|27017)\b/g
  const portMatches = text.match(portPatterns)
  if (portMatches) {
    keywords.push(...portMatches.map(p => `port:${p}`))
  }
  
  // IP 地址
  const ipPatterns = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g
  const ipMatches = text.match(ipPatterns)
  if (ipMatches) {
    keywords.push(...ipMatches)
  }
  
  // 错误关键词
  const errorPatterns = /\b(error|fail|failed|failure|exception|denied|refused|timeout|not found|permission|unauthorized|forbidden)\b/gi
  const errorMatches = text.match(errorPatterns)
  if (errorMatches) {
    keywords.push(...errorMatches.map(e => e.toLowerCase()))
  }
  
  // 去重
  return Array.from(new Set(keywords))
}

/**
 * 计算关键词重叠度
 */
function calculateKeywordOverlap(queryKeywords: string[], memoryKeywords: string[]): number {
  if (queryKeywords.length === 0 || memoryKeywords.length === 0) {
    return 0
  }
  
  const queryLower = queryKeywords.map(k => k.toLowerCase())
  const memoryLower = memoryKeywords.map(k => k.toLowerCase())
  const querySet = new Set(queryLower)
  const memorySet = new Set(memoryLower)
  
  let matchCount = 0
  queryLower.forEach(keyword => {
    if (memorySet.has(keyword)) {
      // 完全匹配
      matchCount++
    } else {
      // 部分匹配（路径包含关系，只在不完全匹配时检查）
      for (const memKeyword of memoryLower) {
        if (keyword !== memKeyword && (keyword.includes(memKeyword) || memKeyword.includes(keyword))) {
          matchCount += 0.5
          break  // 每个 keyword 最多贡献一次部分匹配
        }
      }
    }
  })
  
  // Jaccard 相似度变体
  return matchCount / (querySet.size + memorySet.size - matchCount)
}

/**
 * 检测任务是否在等待用户确认
 * 通过检测"会阻塞等待用户输入"的工具（lifecycle.blocksUntilUserInput）来判断，
 * 哪些工具属于这一类完全由 ToolDefinition._meta 自己声明，本函数不知道具体工具名。
 *
 * @param steps      执行步骤
 * @param lookupMeta 按工具名查 ToolMeta 的回调（由调用方注入）；不提供则永远返回 isPending=false
 * @returns 检测结果，包含是否等待确认和待确认的操作
 */
export function detectPendingConfirmation(
  steps: AgentStep[],
  lookupMeta: LookupToolMeta = NO_LOOKUP
): { isPending: boolean; pendingAction?: string } {
  const isBlockingTool = (toolName: string | undefined): boolean => {
    if (!toolName) return false
    return lookupMeta(toolName)?.lifecycle?.blocksUntilUserInput === true
  }

  // 从后往前找最后一个"阻塞等待用户输入"的 tool_call
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.type !== 'tool_call' || !isBlockingTool(step.toolName)) continue

    // 检查这个 tool_call 是否有对应的 tool_result
    let hasResponse = false
    for (let j = i + 1; j < steps.length; j++) {
      if (steps[j].type === 'tool_result' && steps[j].toolName === step.toolName) {
        hasResponse = true
        break
      }
    }

    if (!hasResponse) {
      // 没有收到响应，任务在等待用户输入。优先取 question，否则取 args 第一个字符串字段
      const args = (step.toolArgs ?? {}) as Record<string, unknown>
      const question = typeof args.question === 'string' ? args.question : undefined
      const fallback = (() => {
        for (const v of Object.values(args)) {
          if (typeof v === 'string' && v.length > 0) return v
        }
        return undefined
      })()
      const text = question ?? fallback
      return {
        isPending: true,
        pendingAction: text ? (text.length > 50 ? text.substring(0, 50) + '...' : text) : undefined
      }
    }
  }

  return { isPending: false }
}

/**
 * 从执行步骤中提取摘要信息
 *
 * 哪些工具的 args 应被视为"主命令"（用于历史摘要单行展示）由 ToolDefinition._meta.argRole.summaryLine
 * 声明（如命令类工具声明 'command'），本函数不知道具体工具名。
 */
function extractDigest(
  steps: AgentStep[],
  userRequest: string,
  lookupMeta: LookupToolMeta = NO_LOOKUP
): TaskDigest {
  const commands: string[] = []
  const paths: string[] = []
  const services: string[] = []
  const errors: string[] = []
  const keyFindings: string[] = []

  // 服务名模式
  const servicePattern = /\b(nginx|apache|mysql|mariadb|postgresql|postgres|redis|mongodb|docker|pm2|systemd|cron)\b/gi

  // 路径模式
  const pathPattern = /(?:\/[\w.-]+)+/g

  for (const step of steps) {
    // 提取命令：只看声明了 argRole.summaryLine 的工具（如 execute_command/exec）
    const summaryField = step.toolName ? lookupMeta(step.toolName)?.argRole?.summaryLine : undefined
    if (summaryField && step.toolArgs && step.toolArgs[summaryField]) {
      const cmd = String(step.toolArgs[summaryField])
      // 只保留命令的简短形式（前 100 字符）
      commands.push(cmd.length > 100 ? cmd.substring(0, 100) + '...' : cmd)

      // 从命令中提取服务名
      const cmdServices = cmd.match(servicePattern)
      if (cmdServices) {
        services.push(...cmdServices.map(s => s.toLowerCase()))
      }

      // 从命令中提取路径
      const cmdPaths = cmd.match(pathPattern)
      if (cmdPaths) {
        paths.push(...cmdPaths)
      }
    }
    
    // 提取错误信息
    if (step.type === 'error' || (step.toolResult && /error|fail|denied|refused/i.test(step.toolResult))) {
      const errorContent = step.type === 'error' ? step.content : step.toolResult
      if (errorContent) {
        // 只保留错误的第一行
        const firstLine = errorContent.split('\n')[0]
        if (firstLine.length < 200) {
          errors.push(firstLine)
        }
      }
    }
    
    // 从工具结果中提取路径
    if (step.toolResult) {
      const resultPaths = step.toolResult.match(pathPattern)
      if (resultPaths) {
        paths.push(...resultPaths.slice(0, 10))  // 限制数量
      }
      
      // 从结果中提取服务名
      const resultServices = step.toolResult.match(servicePattern)
      if (resultServices) {
        services.push(...resultServices.map(s => s.toLowerCase()))
      }
    }
    
    // 从 AI 消息中提取关键发现
    if (step.type === 'message' && step.content) {
      // 提取包含关键词的句子
      const findings = step.content.match(/(?:发现|结果|原因|问题|建议|配置|版本|端口|状态)[：:]\s*[^\n]+/g)
      if (findings) {
        keyFindings.push(...findings.slice(0, 5).map(f => f.trim()))
      }
      
      // 英文关键发现
      const engFindings = step.content.match(/(?:found|result|reason|issue|suggest|config|version|port|status)[：:]\s*[^\n]+/gi)
      if (engFindings) {
        keyFindings.push(...engFindings.slice(0, 5).map(f => f.trim()))
      }
    }
  }
  
  // 从用户请求中提取服务名
  const requestServices = userRequest.match(servicePattern)
  if (requestServices) {
    services.push(...requestServices.map(s => s.toLowerCase()))
  }
  
  // 检测是否等待确认，提取待确认操作
  const { pendingAction } = detectPendingConfirmation(steps, lookupMeta)
  
  return {
    commands: Array.from(new Set(commands)).slice(0, 10),
    paths: Array.from(new Set(paths)).slice(0, 15),
    services: Array.from(new Set(services)).slice(0, 10),
    errors: Array.from(new Set(errors)).slice(0, 5),
    keyFindings: Array.from(new Set(keyFindings)).slice(0, 10),
    pendingAction
  }
}

/**
 * 概要文本中各侧的字符预算（请求 / 结果）。
 * 设计意图是「一句话概要（整条约 50–80 token）」——80 字符 ≈ 40–80 token，
 * 既保留语义，又防注入知识库召回/联络摘录等超长文本撑爆 L4。
 */
export const SUMMARY_REQUEST_MAX_CHARS = 80
export const SUMMARY_RESULT_MAX_CHARS = 80

/**
 * 从消息文本中剥离注入包裹，只留「用户/AI 自己的话」。
 * 注入包裹（知识库召回、系统上下文、上传文档全文、图片附注、思考块）是系统材料，
 * 不应进入任务概要；上传文档/图片只留轻量占位，避免全文进概要。
 * 图片本体（AiMessage.images，base64）是独立字段，天然不经此路径。
 *
 * 边界取舍：
 * - 未闭合的 `<details>` 只锚定消息开头剥离（思考块恒在开头，截断的思考块剥到空是
 *   可接受的）；正文中段出现的 `<details` 视为用户文本原样保留，不误吞。
 * - 通用 HTML 标签剥离要求 `<` 后紧跟字母且标签不跨行——`3 < 5 and 7 > 2` 这类
 *   比较/数学文本不会被误当中间有标签而剥掉。
 * 对已无注入包裹的干净文本重复调用，结果不变。
 */
export function cleanSummarySource(text: string): string {
  return text
    .replace(/<sf_uploaded_docs>[\s\S]*?<\/sf_uploaded_docs>/g, '（附文档）')
    .replace(/<sf_knowledge_refs>[\s\S]*?<\/sf_knowledge_refs>/g, '')
    .replace(/<sf_system_context>[\s\S]*?<\/sf_system_context>/g, '')
    .replace(/<sf_selection_scope>[\s\S]*?<\/sf_selection_scope>/g, '')
    .replace(/<details[\s\S]*?<\/details>/gi, '')
    .replace(/^\s*<details[^>\n]*>[\s\S]*/i, '')
    .replace(/\[系统：用户在本消息中附带了[^\]]*\]/g, '（附图片）')
    .replace(/\[系统：用户附带了[^\]]*\]/g, '（附图片）')
    .replace(/<\/?sf_[^>\n]*>/g, '')
    .replace(/<\/[a-zA-Z][^>\n]*>/g, '')
    .replace(/<[a-zA-Z][^>\n]*>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 按自然边界取概要：首行优先 → 句边界降级 → 字符兜底（+省略号）。
 * 用户多在首行说清意图，后续长段多为粘贴材料；句边界截断保住语义完整。
 */
function summarizeSegment(text: string, maxChars: number): string {
  const cleaned = cleanSummarySource(text)
  if (!cleaned) return ''
  const firstLine = cleaned.split('\n').map(l => l.trim()).find(Boolean) ?? cleaned
  if (firstLine.length <= maxChars) return firstLine
  const sentences = firstLine.split(/(?<=[。！？；.!?;])/).filter(s => s.trim())
  let acc = ''
  for (const s of sentences) {
    if (acc && acc.length + s.length > maxChars) break
    acc += s
  }
  const picked = acc.trim()
  if (picked && picked.length <= maxChars) return picked
  return firstLine.slice(0, maxChars).trimEnd() + '…'
}

/**
 * 生成 L1 总结
 */
function generateSummary(
  userRequest: string,
  status: 'success' | 'failed' | 'aborted' | 'pending_confirmation',
  finalResult?: string,
  pendingAction?: string,
  timestamp?: number
): string {
  // 时间前缀（无 timestamp 时降级为空，保持向后兼容）
  const timePrefix = timestamp ? `[${formatTaskTime(timestamp)}] ` : ''
  // 状态图标
  const statusIcon = status === 'success' ? '✓'
    : status === 'failed' ? '✗'
    : status === 'pending_confirmation' ? '⏳'
    : '⊘'

  // 概要用户请求（剥离注入包裹，句边界截断）
  const shortRequest = summarizeSegment(userRequest, SUMMARY_REQUEST_MAX_CHARS)

  // 从最终结果中提取关键信息
  const resultSummary = finalResult ? summarizeSegment(finalResult, SUMMARY_RESULT_MAX_CHARS) : ''

  if (status === 'aborted') {
    return `${timePrefix}${statusIcon} ${shortRequest} → 已中止`
  }

  if (status === 'pending_confirmation') {
    const action = pendingAction ? `: ${pendingAction}` : ''
    return `${timePrefix}${statusIcon} ${shortRequest} → 等待确认${action}`
  }

  if (resultSummary) {
    return `${timePrefix}${statusIcon} ${shortRequest} → ${resultSummary}`
  }

  return `${timePrefix}${statusIcon} ${shortRequest}`
}

/**
 * 任务记忆存储
 * 管理历史任务的多层次上下文
 */
export class TaskMemoryStore {
  private memories: Map<string, TaskMemory> = new Map()
  private taskOrder: string[] = []  // 按时间顺序存储任务 ID
  private maxMemories: number = 50  // 最大存储任务数

  /**
   * @param lookupMeta 按工具名查 ToolMeta 的回调（由 Agent 注入）。
   * 不传入时降级为"返回 undefined"——所有 metadata 检查都拿到 undefined，
   * `detectPendingConfirmation` / `extractDigest` 会按"无声明"处理（保守不识别）。
   * @param maxMemories 最大存储任务数（默认 50）。wakeup 上下文只取最近 30 条 L4，默认上限已够。
   */
  constructor(
    private readonly lookupMeta: LookupToolMeta = NO_LOOKUP,
    maxMemories?: number
  ) {
    if (maxMemories !== undefined) this.maxMemories = maxMemories
  }

  /**
   * 保存任务记忆
   * @param taskId 任务 ID
   * @param userRequest 用户原始请求
   * @param steps 完整执行步骤
   * @param status 任务状态
   * @param finalResult 最终结果（用于生成总结）
   */
  saveTask(
    taskId: string,
    userRequest: string,
    steps: AgentStep[],
    status: 'success' | 'failed' | 'aborted' | 'pending_confirmation',
    finalResult?: string,
    messages?: AiMessage[]
  ): TaskMemory {
    // 生成 L2 摘要（先提取，因为 pendingAction 会用到）
    const digest = extractDigest(steps, userRequest, this.lookupMeta)

    // 任务时间戳（summary 生成要用，所以先算）
    const timestamp = Date.now()

    // 生成 L1 总结（带时间前缀，让 AI 在摘要中看到任务时间）
    const summary = generateSummary(userRequest, status, finalResult, digest.pendingAction, timestamp)
    
    // 提取关键词（从用户请求 + 摘要内容）
    const keywordSource = [
      userRequest,
      ...digest.commands,
      ...digest.paths,
      ...digest.services,
      ...digest.errors,
      ...digest.keyFindings
    ].join(' ')
    const keywords = extractKeywords(keywordSource)
    
    const memory: TaskMemory = {
      id: taskId,
      userRequest,
      timestamp,
      status,
      summary,
      digest,
      fullSteps: steps,
      messages,
      keywords
    }
    
    // 存储（如果已存在则更新，不重复添加到 taskOrder）
    const isUpdate = this.memories.has(taskId)
    this.memories.set(taskId, memory)
    
    if (!isUpdate) {
      this.taskOrder.push(taskId)
      
      // 清理旧记忆（保持在限制内）
      while (this.taskOrder.length > this.maxMemories) {
        const oldestId = this.taskOrder.shift()
        if (oldestId) {
          this.memories.delete(oldestId)
        }
      }
    }
    
    return memory
  }
  
  /**
   * 获取 L1 总结列表（用于始终在上下文中的部分）
   * @param limit 最大返回数量
   */
  getSummaries(limit: number = 20): TaskSummary[] {
    const summaries: TaskSummary[] = []
    
    // 从最新到最旧
    const ids = [...this.taskOrder].reverse().slice(0, limit)
    
    for (const id of ids) {
      const memory = this.memories.get(id)
      if (memory) {
        summaries.push({
          id: memory.id,
          summary: memory.summary,
          status: memory.status,
          timestamp: memory.timestamp
        })
      }
    }
    
    return summaries
  }
  
  /**
   * 语义预加载：根据当前任务获取相关的历史任务 L2 摘要
   * @param query 当前用户请求
   * @param topK 返回前 K 个最相关的
   */
  getRelatedDigests(query: string, topK: number = 3): RelatedTaskDigest[] {
    const queryKeywords = extractKeywords(query)
    
    if (queryKeywords.length === 0) {
      return []
    }
    
    const scored: Array<{ memory: TaskMemory; score: number }> = []
    
    // 使用 Array.from 避免 MapIterator 迭代问题
    Array.from(this.memories.values()).forEach(memory => {
      const score = calculateKeywordOverlap(queryKeywords, memory.keywords)
      if (score > 0.1) {  // 最低相关性阈值
        scored.push({ memory, score })
      }
    })
    
    // 按相关性排序
    scored.sort((a, b) => b.score - a.score)
    
    // 返回前 K 个
    return scored.slice(0, topK).map(({ memory, score }) => ({
      taskId: memory.id,
      userRequest: memory.userRequest,
      digest: memory.digest,
      relevanceScore: score
    }))
  }
  
  /**
   * recall(detail="summary"): 获取指定任务的 L2 摘要
   * @param taskId 任务 ID
   */
  getDigest(taskId: string): { userRequest: string; digest: TaskDigest } | null {
    const memory = this.memories.get(taskId)
    if (!memory) {
      return null
    }
    return {
      userRequest: memory.userRequest,
      digest: memory.digest
    }
  }
  
  /**
   * recall(detail="full"): 获取 L3 完整步骤
   * @param taskId 任务 ID
   * @param stepIndex 可选，指定步骤索引
   */
  getFullSteps(taskId: string, stepIndex?: number): AgentStep[] | AgentStep | null {
    const memory = this.memories.get(taskId)
    if (!memory) {
      return null
    }
    
    if (stepIndex !== undefined) {
      if (stepIndex < 0 || stepIndex >= memory.fullSteps.length) {
        return null
      }
      return memory.fullSteps[stepIndex]
    }
    
    return memory.fullSteps
  }
  
  /**
   * 获取任务数量
   */
  getTaskCount(): number {
    return this.memories.size
  }
  
  /**
   * 检查任务是否存在
   */
  hasTask(taskId: string): boolean {
    return this.memories.has(taskId)
  }
  
  /**
   * 获取任务的完整信息（用于调试）
   */
  getTask(taskId: string): TaskMemory | null {
    return this.memories.get(taskId) || null
  }
  
  /**
   * 清空所有记忆
   */
  clear(): void {
    this.memories.clear()
    this.taskOrder = []
  }

  /**
   * 更新任务的 AI 建议压缩级别
   * @param taskId 任务 ID
   * @param level 建议的压缩级别 (0-4)
   * @returns 是否成功（任务不存在时返回 false）
   */
  updateSuggestedLevel(taskId: string, level: import('./context-builder').CompressionLevel): boolean {
    const memory = this.memories.get(taskId)
    if (!memory) return false
    memory.aiSuggestedLevel = level
    return true
  }

  /**
   * 删除指定任务记忆
   * @param taskId 任务 ID
   * @returns 是否成功（任务不存在时返回 false）
   */
  removeTask(taskId: string): boolean {
    if (!this.memories.has(taskId)) return false
    this.memories.delete(taskId)
    this.taskOrder = this.taskOrder.filter(id => id !== taskId)
    return true
  }
  
  /**
   * 获取按时间顺序的任务列表（最近的在前）
   * 用于上下文构建器的渐进式降级
   */
  getTasksInOrder(): TaskMemory[] {
    // 从最新到最旧
    const orderedIds = [...this.taskOrder].reverse()
    const tasks: TaskMemory[] = []
    
    for (const id of orderedIds) {
      const task = this.memories.get(id)
      if (task) {
        tasks.push(task)
      }
    }
    
    return tasks
  }
  
  /**
   * 格式化 L1 总结列表为上下文字符串
   */
  formatSummariesForContext(limit?: number): string {
    const summaries = this.getSummaries(limit)
    if (summaries.length === 0) {
      return ''
    }
    
    const lines = summaries.map(s => `- [${s.id}] ${s.summary}`)
    return lines.join('\n')
  }
  
  /**
   * 格式化相关摘要为上下文字符串
   */
  formatRelatedDigestsForContext(digests: RelatedTaskDigest[]): string {
    if (digests.length === 0) {
      return ''
    }
    
    const sections: string[] = []
    
    for (const { taskId, userRequest, digest } of digests) {
      const lines: string[] = [`[${taskId} - ${userRequest}]`]
      
      if (digest.commands.length > 0) {
        lines.push(`• 命令: ${digest.commands.join(', ')}`)
      }
      if (digest.paths.length > 0) {
        lines.push(`• 路径: ${digest.paths.slice(0, 5).join(', ')}`)
      }
      if (digest.services.length > 0) {
        lines.push(`• 服务: ${digest.services.join(', ')}`)
      }
      if (digest.errors.length > 0) {
        lines.push(`• 错误: ${digest.errors.join('; ')}`)
      }
      if (digest.keyFindings.length > 0) {
        lines.push(`• 发现: ${digest.keyFindings.slice(0, 3).join('; ')}`)
      }
      
      sections.push(lines.join('\n'))
    }
    
    return sections.join('\n\n')
  }
}

// 也导出类，方便测试或创建独立实例
export { extractKeywords, calculateKeywordOverlap, extractDigest, generateSummary }

