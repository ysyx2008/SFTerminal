/**
 * 上下文构建器
 * 实现智能分层记忆：按预算填充 + 渐进式降级
 */

import type { AiMessage } from '../ai.service'
import type { TaskMemory, AgentStep } from './types'
import type { TaskMemoryStore } from './task-memory'
// token 估算共享纯函数(与 ContextWindowManager 共用同一实现,消除逐字节重复)
import { estimateTextTokens as estimateTokens } from './token-estimate'

/**
 * 格式化任务时间戳（对齐 AI 消息包体中的时间格式，如文件列表/待办截止时间）。
 * 使用 new Date(ts).toLocaleString() 默认输出，含年月日时分秒。
 */
function formatTaskTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

// ==================== 类型定义 ====================

/**
 * 压缩级别
 * Level 0: 完整对话（用户请求 + 所有工具调用/结果 + AI 回复）
 * Level 1: 压缩对话（用户请求 + 压缩后的工具输出 + AI 回复）
 * Level 2: 精简对话（用户请求 + AI 最终回复）
 * Level 3: L2 摘要（命令、路径、关键发现）
 * Level 4: L1 总结（一句话概要）
 */
export type CompressionLevel = 0 | 1 | 2 | 3 | 4

/**
 * 上下文预算分配
 */
export interface ContextBudget {
  total: number              // 总预算（tokens）
  systemPrompt: number       // 系统提示基础部分
  knowledge: number          // 知识库/主机记忆
  recentTasks: number        // 最近任务区（按预算填充）
  nearTasks: number          // 较近任务摘要
  historySummary: number     // 历史任务总结
  currentConversation: number // 当前对话预留
}

/**
 * 带压缩级别的任务上下文
 */
export interface TaskWithLevel {
  taskId: string
  level: CompressionLevel    // 实际使用的压缩级别
  tokens: number             // 实际占用的 tokens
  content: AiMessage[] | string  // Level 0-2 返回消息数组，Level 3-4 返回字符串
  userRequest: string        // 用户原始请求（用于显示）
  status: 'success' | 'failed' | 'aborted' | 'pending_confirmation'
}

/**
 * 上下文构建结果
 */
export interface ContextBuildResult {
  // Level 0-2 的任务，作为消息注入
  recentTaskMessages: AiMessage[]
  // Level 3-4 的任务，作为摘要/总结写入系统提示
  taskSummarySection: string
  // 所有可用任务的ID列表（用于 recall 工具）
  availableTaskIds: Array<{ id: string; summary: string }>
  // 统计信息
  stats: {
    totalTasks: number
    level0Count: number
    level1Count: number
    level2Count: number
    level3Count: number
    level4Count: number
    usedTokens: number
    budget: number
  }
}

// ==================== 预算计算 ====================

/**
 * 根据模型上下文长度计算预算分配
 */
export function calculateBudget(contextLength: number): ContextBudget {
  // 总预算为上下文长度的 80%（预留 20% 给当前对话的工具调用等）
  const total = Math.floor(contextLength * 0.8)
  
  return {
    total,
    systemPrompt: 3000,                           // 固定约 3000 tokens
    knowledge: Math.floor(total * 0.15),          // 15% 给知识库
    recentTasks: Math.floor(total * 0.40),        // 40% 给最近任务（按预算填充）
    nearTasks: Math.floor(total * 0.10),          // 10% 给较近任务摘要
    historySummary: Math.floor(total * 0.05),     // 5% 给历史总结
    currentConversation: Math.floor(total * 0.10) // 10% 预留给当前对话
  }
}

// ==================== 消息序列校验 ====================

/**
 * 修复 assistant.tool_calls 后的消息序列，确保 OpenAI/DeepSeek 协议合规。
 *
 * 处理三类问题：
 *
 * 1. **缺失的 tool result**（残缺序列）
 *    场景：checkpoint 在工具执行中途写盘，或 App 在工具执行期间退出，
 *    导致 assistant 消息含 tool_calls 但缺少对应的 tool 消息。
 *    修复：为每个未配对的 tool_call_id 补一条占位 tool 消息。
 *
 * 2. **夹杂的 user 消息**（错位序列）
 *    场景：旧版本（修复前）在每个工具完成后立即 push 一条 user 消息携带图片，
 *    导致 user 消息夹在同批 tool 消息之间。
 *    DeepSeek API 严格校验：tool_calls 后必须连续跟随对应每个 tool_call_id 的
 *    tool 消息，中间不允许 user/assistant，否则报
 *    "insufficient tool messages following tool_calls message"。
 *    修复：把夹杂的 user 消息挪到所有 tool 消息之后。
 *
 * 3. **孤儿 tool 消息**（无主序列）
 *    场景：splitMessagesIntoTasks 把工具图片注入的 user 消息当作任务边界切分，
 *    导致某个 task 的 messages 第一条/中间出现一条 tool 消息但前面没有
 *    对应的 assistant tool_calls。或者 history 数据中其他原因留下的孤儿 tool。
 *    DeepSeek/OpenAI 都会报
 *    "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"。
 *    修复：把这种 tool 消息转成 user 消息（保留内容但角色合法）。
 *
 * 当前 push 路径已不再产生第二类问题（见 Agent.flushPendingToolImages），
 * 此修复主要为兼容历史持久化数据。
 */
export function sanitizeToolCallSequence(messages: AiMessage[]): AiMessage[] {
  const result: AiMessage[] = []

  let i = 0
  while (i < messages.length) {
    const msg = messages[i]

    // 第三类问题预防：当前位置不在 assistant.tool_calls 的扫描范围内（下方循环
    // 会向前推进 i，所以这里能到达的 tool 消息都是「孤儿」），转成 user 消息保留内容。
    if (msg.role === 'tool') {
      const toolName = (msg.tool_call_id ? `[tool result orphan: ${msg.tool_call_id}]` : '[tool result orphan]')
      result.push({
        role: 'user',
        content: `${toolName}\n${msg.content || ''}`
      })
      i++
      continue
    }

    result.push(msg)

    if (msg.role !== 'assistant' || !msg.tool_calls?.length) {
      i++
      continue
    }

    const requiredIds = new Set(msg.tool_calls.map(tc => tc.id))
    const displacedMessages: AiMessage[] = []  // 错位夹在 tool 之间的非 tool 消息（user/system 等）

    // 向前扫描直到下一个 assistant 消息：tool 消息保持原位，其他消息暂存延后
    let j = i + 1
    while (j < messages.length) {
      const next = messages[j]
      if (next.role === 'assistant') break
      if (next.role === 'tool' && next.tool_call_id) {
        result.push(next)
        requiredIds.delete(next.tool_call_id!)
      } else {
        displacedMessages.push(next)
      }
      j++
    }

    // 为缺失的 tool_call_id 补占位
    for (const missingId of requiredIds) {
      const toolName = msg.tool_calls.find(tc => tc.id === missingId)?.function.name || 'unknown'
      result.push({
        role: 'tool',
        content: `[${toolName}: 执行结果未记录]`,
        tool_call_id: missingId
      })
    }

    // 把错位的非 tool 消息挪到所有 tool 消息之后
    for (const displaced of displacedMessages) {
      result.push(displaced)
    }

    i = j  // 跳到下一个 assistant（或结尾）
  }

  return result
}

// ==================== 压缩工具 ====================

/**
 * 压缩工具输出（用于 Level 1）
 */
function compressToolOutput(output: string, maxLength: number = 1500): string {
  if (output.length <= maxLength) {
    return output
  }
  
  const lines = output.split('\n')
  
  // 如果是结构化输出，保留头尾
  if (lines.length > 15) {
    const headLines = lines.slice(0, 8)
    const tailLines = lines.slice(-5)
    const omitted = lines.length - 13
    return [
      ...headLines,
      `\n... [${omitted} 行已省略] ...\n`,
      ...tailLines
    ].join('\n')
  }
  
  // 否则简单截断
  return output.substring(0, maxLength) + `\n... [已截断，原长度: ${output.length}]`
}

/**
 * 获取任务的最低压缩级别（特殊任务保护）
 * @param task 任务记忆
 * @param taskIndex 任务在时间顺序中的索引（0 = 最近一个任务）
 */
function getMinCompressionLevel(task: TaskMemory, taskIndex: number): CompressionLevel {
  // 最近 1 个任务：Level 0（完整对话），确保 AI 能理解上下文连续性
  if (taskIndex === 0) return 0
  
  // 之后 2 个任务：Level 1（压缩对话），保留工具调用摘要
  if (taskIndex <= 2) return 1
  
  // 之后 3 个任务：Level 2（精简对话），仅保留请求和回复
  if (taskIndex <= 5) return 2
  
  // 等待确认的任务：至少保留 Level 2（用户请求 + AI 确认问题）
  if (task.status === 'pending_confirmation') return 2
  
  // 被中止的任务：至少保留 Level 2（用户请求 + 中止原因）
  if (task.status === 'aborted') return 2
  
  // 失败的任务：至少保留 Level 2（用户请求 + 错误信息）
  if (task.status === 'failed') return 2
  
  // 更早的成功任务：降级为摘要，节省 token
  return 4
}

/**
 * 从 AgentStep[] 提取最终 AI 回复
 */
function extractFinalReply(steps: AgentStep[]): string {
  // 从后往前找最后一个 message 类型的步骤
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.type === 'message' && step.content) {
      return step.content
    }
  }
  return ''
}

/**
 * 将任务转换为指定压缩级别的内容
 */
function compressTask(
  task: TaskMemory, 
  level: CompressionLevel
): AiMessage[] | string {
  switch (level) {
    case 0:
      // Level 0: 完整对话
      return getFullMessages(task)
    
    case 1:
      // Level 1: 压缩工具输出
      return getCompressedMessages(task)
    
    case 2:
      // Level 2: 只保留用户请求和最终回复
      return getSimplifiedMessages(task)
    
    case 3:
      // Level 3: L2 摘要
      return formatDigest(task)
    
    case 4:
      // Level 4: L1 总结
      return task.summary
    
    default:
      return task.summary
  }
}

/**
 * Level 0: 获取完整消息历史
 * 
 * 从 AgentStep[] 重建 API 消息格式。需要处理两种情况：
 * 1. debug 模式：tool_call 和 tool_result 步骤都存在
 * 2. 非 debug 模式：可能只有 tool_call 步骤，tool_result 被省略（成功的命令执行等）
 * 
 * 匹配策略：收集 tool_result 步骤，按 toolName 匹配到 pending tool_call；
 * 遇到 message 步骤时刷新所有 pending tool_call（无论是否有对应 result）。
 */
function getFullMessages(task: TaskMemory): AiMessage[] {
  // 优先使用直接记录的完整 API 对话（无需从 steps 重建）
  if (task.messages && task.messages.length > 0) {
    return sanitizeToolCallSequence(task.messages.map(m => ({ ...m })))
  }
  
  // Fallback: 从 fullSteps 重建（messages 不可用时的兼容路径）
  const messages: AiMessage[] = []
  
  // 用户请求
  messages.push({ role: 'user', content: task.userRequest })
  
  // 遍历步骤，构建完整对话
  let currentAssistantContent = ''
  let pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = []
  let collectedResults = new Map<string, string>() // tool_call step id -> result content
  
  /**
   * 将 pending tool_calls 刷新为 assistant + tool 消息
   * @param isInterrupted 是否为任务中断（最后仍有未完成的 tool_call）
   */
  function flushPendingToolCalls(isInterrupted: boolean) {
    if (pendingToolCalls.length === 0) return
    
    messages.push({
      role: 'assistant',
      content: currentAssistantContent || '',
      tool_calls: pendingToolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments }
      }))
    })
    currentAssistantContent = ''
    
    for (const tc of pendingToolCalls) {
      let resultContent: string
      const collected = collectedResults.get(tc.id)
      if (collected !== undefined) {
        resultContent = collected
      } else if (isInterrupted) {
        resultContent = '[任务中断，工具执行结果未记录]'
      } else {
        // 工具已执行完成但结果未记录在步骤中（非 debug 模式的正常情况）
        resultContent = '[completed]'
      }
      messages.push({
        role: 'tool',
        content: resultContent,
        tool_call_id: tc.id
      })
    }
    
    pendingToolCalls = []
    collectedResults = new Map()
  }
  
  for (const step of task.fullSteps) {
    if (step.type === 'tool_call' && step.toolName) {
      // 工具调用
      pendingToolCalls.push({
        id: step.id,
        name: step.toolName,
        arguments: JSON.stringify(step.toolArgs || {})
      })
    } else if (step.type === 'tool_result' && step.toolName) {
      // 收集工具结果，按 toolName 匹配到第一个尚未匹配的 pending tool_call
      const matched = pendingToolCalls.find(tc => 
        tc.name === step.toolName && !collectedResults.has(tc.id)
      )
      if (matched) {
        collectedResults.set(matched.id, step.toolResult || '')
      }
    } else if (step.type === 'message') {
      // 遇到 AI 消息意味着之前的工具调用已全部完成，刷新 pending
      flushPendingToolCalls(false)
      currentAssistantContent += (currentAssistantContent ? '\n' : '') + step.content
    }
  }
  
  // 步骤遍历结束，处理剩余的 pending tool_calls
  // 根据任务状态判断：成功的任务视为工具已完成，失败/中止的任务视为中断
  if (pendingToolCalls.length > 0) {
    const isInterrupted = task.status === 'aborted' || task.status === 'failed'
    flushPendingToolCalls(isInterrupted)
  }
  
  // 输出最后的 assistant 消息（如果还有未输出的文本内容）
  if (currentAssistantContent) {
    messages.push({
      role: 'assistant',
      content: currentAssistantContent
    })
  }
  
  return messages
}

/**
 * Level 1: 获取压缩工具输出后的消息
 */
function getCompressedMessages(task: TaskMemory): AiMessage[] {
  const messages: AiMessage[] = []
  
  // 用户请求
  messages.push({ role: 'user', content: task.userRequest })
  
  // 构建压缩后的 assistant 消息
  let assistantContent = ''
  
  // 提取关键工具调用摘要
  const toolSummaries: string[] = []
  for (const step of task.fullSteps) {
    if (step.type === 'tool_call' && step.toolName) {
      let summary = `[${step.toolName}]`
      if (step.toolArgs?.command) {
        const cmd = String(step.toolArgs.command)
        summary += ` ${cmd.length > 80 ? cmd.substring(0, 80) + '...' : cmd}`
      } else if (step.toolArgs?.path) {
        summary += ` ${step.toolArgs.path}`
      }
      toolSummaries.push(summary)
    } else if (step.type === 'tool_result' && step.toolResult) {
      // 压缩工具输出
      const compressed = compressToolOutput(step.toolResult)
      if (toolSummaries.length > 0) {
        toolSummaries[toolSummaries.length - 1] += `\n→ ${compressed}`
      }
    } else if (step.type === 'message' && step.content) {
      assistantContent = step.content  // 保留最后一个消息
    }
  }
  
  let fullAssistantContent = ''
  if (toolSummaries.length > 0) {
    fullAssistantContent = `**执行摘要:**\n${toolSummaries.join('\n')}\n\n`
  }
  fullAssistantContent += assistantContent
  
  messages.push({ role: 'assistant', content: fullAssistantContent || task.summary || '[no response]' })
  
  return messages
}

/**
 * Level 2: 只保留用户请求和最终回复
 */
function getSimplifiedMessages(task: TaskMemory): AiMessage[] {
  const finalReply = extractFinalReply(task.fullSteps)
  
  let statusNote = ''
  if (task.status === 'aborted') {
    statusNote = '\n\n[任务已被用户中止]'
  } else if (task.status === 'failed') {
    statusNote = '\n\n[任务执行失败]'
  }
  
  const assistantContent = finalReply + statusNote || task.summary || '[no response]'
  return [
    { role: 'user', content: task.userRequest },
    { role: 'assistant', content: assistantContent }
  ]
}

/**
 * Level 3: 格式化 L2 摘要
 */
function formatDigest(task: TaskMemory): string {
  const { digest } = task
  const timePrefix = `[${formatTaskTime(task.timestamp)}] `
  const lines: string[] = [`${timePrefix}[${task.id}] ${task.userRequest}`]
  
  if (digest.commands.length > 0) {
    lines.push(`• 命令: ${digest.commands.slice(0, 5).join(', ')}`)
  }
  if (digest.paths.length > 0) {
    lines.push(`• 路径: ${digest.paths.slice(0, 5).join(', ')}`)
  }
  if (digest.services.length > 0) {
    lines.push(`• 服务: ${digest.services.join(', ')}`)
  }
  if (digest.errors.length > 0) {
    lines.push(`• 错误: ${digest.errors.slice(0, 2).join('; ')}`)
  }
  if (digest.keyFindings.length > 0) {
    lines.push(`• 发现: ${digest.keyFindings.slice(0, 2).join('; ')}`)
  }
  
  const statusIcon = task.status === 'success' ? '✓' 
    : task.status === 'failed' ? '✗' 
    : task.status === 'pending_confirmation' ? '⏳'
    : '⊘'
  lines.push(`• 状态: ${statusIcon} ${task.status}`)
  
  return lines.join('\n')
}

// ==================== Token 估算 ====================

/**
 * 估算消息数组的 token 数
 */
function estimateMessagesTokens(messages: AiMessage[]): number {
  return messages.reduce((sum, msg) => {
    let tokens = estimateTokens(msg.content)
    if (msg.tool_calls) {
      tokens += msg.tool_calls.reduce((t, tc) => 
        t + estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments), 0)
    }
    return sum + tokens
  }, 0)
}

/**
 * 估算任务在指定压缩级别的 token 数
 */
function estimateTaskTokens(task: TaskMemory, level: CompressionLevel): number {
  const content = compressTask(task, level)
  if (Array.isArray(content)) {
    return estimateMessagesTokens(content)
  }
  return estimateTokens(content)
}

// ==================== 上下文引用检测 ====================

/**
 * 检测用户是否引用之前的上下文
 */
export function detectContextReference(userMessage: string): boolean {
  const patterns = [
    /刚才|刚刚|上次|之前|继续|接着|上一个|前面/,
    /那个|这个|同样的|一样的|类似的/,
    /再试|重试|再来|再做/,
    /again|continue|previous|last|same|retry|redo/i
  ]
  return patterns.some(p => p.test(userMessage))
}

// ==================== 构建选项 ====================

export interface TaskHistoryOptions {
  /** 最多取几条任务（默认不限，取决于 token 预算） */
  maxTasks?: number
  /** 强制最低压缩级别（默认按 getMinCompressionLevel 规则） */
  minCompressionLevel?: CompressionLevel
}

// ==================== 核心构建函数 ====================

/**
 * 按预算构建最近任务上下文（渐进式降级）
 */
export function buildRecentTasksContext(
  taskMemoryStore: TaskMemoryStore,
  budget: number,
  userMessage?: string,
  options?: TaskHistoryOptions
): ContextBuildResult {
  const result: ContextBuildResult = {
    recentTaskMessages: [],
    taskSummarySection: '',
    availableTaskIds: [],
    stats: {
      totalTasks: 0,
      level0Count: 0,
      level1Count: 0,
      level2Count: 0,
      level3Count: 0,
      level4Count: 0,
      usedTokens: 0,
      budget
    }
  }
  
  // 检测是否需要更详细的上下文
  const needsDetailedContext = userMessage ? detectContextReference(userMessage) : false
  const effectiveBudget = needsDetailedContext 
    ? Math.min(budget * 1.3, budget + 5000)  // 最多增加 30% 或 5000 tokens
    : budget
  
  let usedTokens = 0
  const processedTasks: TaskWithLevel[] = []
  const summaryLines: string[] = []
  
  // 获取按时间顺序的任务（最近的在前）
  const tasks = taskMemoryStore.getTasksInOrder()
  const taskLimit = options?.maxTasks ? Math.min(options.maxTasks, tasks.length) : tasks.length
  result.stats.totalTasks = taskLimit
  
  const forcedMinLevel = options?.minCompressionLevel
  
  for (let taskIndex = 0; taskIndex < taskLimit; taskIndex++) {
    const task = tasks[taskIndex]
    const ruleLevel = task.aiSuggestedLevel ?? getMinCompressionLevel(task, taskIndex)
    const minLevel = forcedMinLevel !== undefined
      ? Math.max(ruleLevel, forcedMinLevel) as CompressionLevel
      : ruleLevel
    let placed = false
    
    // 尝试各个压缩级别（从完整到精简）
    for (let level = 0 as CompressionLevel; level <= 4; level++) {
      // 跳过低于最低级别的档位。
      // - 显式 minCompressionLevel（如 wakeup 强制 L4）：严格遵守，不得「软放行」L3
      // - 默认渐进路径：ruleLevel 为 4 时仍允许先试 L3（预算内尽量多留一点结构化摘要）
      if (level < minLevel) {
        if (forcedMinLevel !== undefined || level < 3) continue
      }
      
      const tokens = estimateTaskTokens(task, level)
      
      if (usedTokens + tokens <= effectiveBudget) {
        processedTasks.push({
          taskId: task.id,
          level,
          tokens,
          content: compressTask(task, level),
          userRequest: task.userRequest,
          status: task.status
        })
        usedTokens += tokens
        placed = true
        
        // 更新统计
        switch (level) {
          case 0: result.stats.level0Count++; break
          case 1: result.stats.level1Count++; break
          case 2: result.stats.level2Count++; break
          case 3: result.stats.level3Count++; break
          case 4: result.stats.level4Count++; break
        }
        break
      }
    }
    
    // 如果所有级别都放不下（即使是 L4），跳过这个任务
    if (!placed) {
      // 预算基本用尽，停止处理
      if (usedTokens >= effectiveBudget * 0.95) break
    }
  }
  
  result.stats.usedTokens = usedTokens
  
  // 分类处理：Level 0-2 作为消息，Level 3-4 作为摘要
  // processedTasks 是从新到旧的顺序，需要反转为自然时间顺序（从旧到新）
  const reversedTasks = [...processedTasks].reverse()
  
  for (const task of reversedTasks) {
    if (task.level <= 2) {
      // 作为消息注入（从旧到新，符合对话顺序）
      const messages = task.content as AiMessage[]
      result.recentTaskMessages.push(...messages)
    } else {
      // 作为摘要（从旧到新，符合自然阅读顺序）
      summaryLines.push(task.content as string)
    }
  }
  
  if (summaryLines.length > 0) {
    result.taskSummarySection = summaryLines.join('\n\n')
  }
  
  // 填充所有可用任务的ID列表（从旧到新，自然时间顺序）
  const summaries = taskMemoryStore.getSummaries(50)
  result.availableTaskIds = summaries.map(s => ({ id: s.id, summary: s.summary })).reverse()
  
  return result
}

/**
 * 完整的上下文构建入口
 */
export function buildTaskHistoryContext(
  taskMemoryStore: TaskMemoryStore,
  contextLength: number,
  userMessage: string,
  options?: TaskHistoryOptions
): ContextBuildResult {
  const budget = calculateBudget(contextLength)
  return buildRecentTasksContext(taskMemoryStore, budget.recentTasks, userMessage, options)
}

