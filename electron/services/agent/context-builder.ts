/**
 * 上下文构建器
 * 实现智能分层记忆：按预算填充 + 渐进式降级
 */

import type { AiMessage } from '../ai.service'
import type { TaskMemory, AgentStep } from './types'
import type { TaskMemoryStore } from './task-memory'
// token 估算共享纯函数(与 ContextWindowManager 共用同一实现,消除逐字节重复)
import { estimateTextTokens as estimateTokens } from './token-estimate'

// ==================== 类型定义 ====================

/** 真相源在 types.ts；此处 re-export 保持既有引用路径可用 */
import type { CompressionLevel } from './types'
export type { CompressionLevel }

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
  level: CompressionLevel    // 同一场装配固定为 0；唤醒 summaryOnly 记在 level4Count
  tokens: number             // 实际占用的 tokens
  content: AiMessage[] | string
  userRequest: string        // 用户原始请求（用于显示）
  status: 'success' | 'failed' | 'aborted' | 'pending_confirmation'
}

/**
 * 上下文构建结果
 */
export interface ContextBuildResult {
  // 同一场原文（或单条过长后单独收过的原文）
  recentTaskMessages: AiMessage[]
  // 仅唤醒 summaryOnly：一句话概要
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
 * 根据模型上下文长度计算预算分配。
 *
 * `fixedPrefixTokens` 是每次请求都随行、不可压缩的固定开销（system prompt +
 * 工具 schema）。实测最小配置就有 1.3 万 tokens，装了技能/插件/MCP 后更大——
 * 必须先扣掉再分配，否则各分区之和加上它会超出窗口：32K 模型上原先切出的
 * 预算合计 39.7K，已经超发 24%。
 *
 * 不传 fixedPrefixTokens 时退回原有的「按窗口切百分比」，仅供不掌握前缀信息
 * 的调用方（如单测）使用。
 */
export function calculateBudget(contextLength: number, fixedPrefixTokens = 0): ContextBudget {
  // 扣掉固定开销后，再留本轮说话 + 写交接的空位；其余全部给这场历史。
  // 大窗口用绝对上限，避免为了凑比例把历史克扣掉。
  const available = Math.max(0, contextLength - fixedPrefixTokens)
  const reserve = Math.min(Math.floor(available * 0.2), 32_000)
  const history = Math.max(0, available - reserve)

  return {
    total: history,
    systemPrompt: 3000,
    knowledge: 0,
    recentTasks: history,
    nearTasks: 0,
    historySummary: 0,
    currentConversation: reserve,
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

/** 从对话消息里取最后一条有正文的助手回复（系统注入不计入） */
function extractFinalReplyFromMessages(messages: AiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || !msg.content || msg._systemInjected) continue
    return msg.content
  }
  return ''
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

/** 同一场装配：原文 + 实际收场注记。历史图不整场重塞。 */
function originalTaskMessages(task: TaskMemory): AiMessage[] {
  return ensureQaFloor(getFullMessages(task), task)
}

function ensureQaFloor(messages: AiMessage[], task: TaskMemory): AiMessage[] {
  const out = messages.length ? messages.map(m => ({ ...m })) : [qaUserMessage(task)]
  const lastAsst = [...out].reverse().find(m => m.role === 'assistant' && !m._systemInjected)
  const notes: string[] = []
  if (task.status === 'aborted') notes.push('[任务已被用户中止]')
  else if (task.status === 'failed') notes.push('[任务执行失败]')
  else if (task.status === 'pending_confirmation') notes.push('[还在等待确认]')

  if (!lastAsst?.content) {
    out.push({ role: 'assistant', content: actualClosing(task) })
    return out
  }
  for (const note of notes) {
    if (!lastAsst.content.includes(note)) {
      lastAsst.content = `${lastAsst.content}\n\n${note}`
    }
  }
  return out
}

/**
 * Level 0: 获取完整消息历史
 *
 * 优先使用这场对话的消息；没有消息时才从界面步骤重建。需要处理两种情况：
 * 1. debug 模式：tool_call 和 tool_result 步骤都存在
 * 2. 非 debug 模式：可能只有 tool_call 步骤，tool_result 被省略（成功的命令执行等）
 * 
 * 匹配策略：收集 tool_result 步骤，按 toolName 匹配到 pending tool_call；
 * 遇到 message 步骤时刷新所有 pending tool_call（无论是否有对应 result）。
 */
function getFullMessages(task: TaskMemory): AiMessage[] {
  // 优先使用直接记录的完整 API 对话（无需从 steps 重建）
  if (task.messages && task.messages.length > 0) {
    return omitHistoryImages(sanitizeToolCallSequence(task.messages.map(m => ({ ...m }))))
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

function omitHistoryImages(messages: AiMessage[]): AiMessage[] {
  return messages.map(m => {
    if (!m.images?.length) return m
    const { images: _images, ...rest } = m
    return rest
  })
}

function qaUserMessage(task: TaskMemory): AiMessage {
  return { role: 'user', content: task.userRequest }
}

/** 这一轮实际怎么收场：有交代就留交代，停了/败了/在等照实留，不编造成功收场。 */
function actualClosing(task: TaskMemory): string {
  const finalReply = (task.messages && task.messages.length > 0
    ? extractFinalReplyFromMessages(task.messages)
    : '') || extractFinalReply(task.fullSteps)

  const notes: string[] = []
  if (task.status === 'aborted') notes.push('[任务已被用户中止]')
  else if (task.status === 'failed') notes.push('[任务执行失败]')
  else if (task.status === 'pending_confirmation') notes.push('[还在等待确认]')

  if (finalReply) {
    return notes.length ? `${finalReply}\n\n${notes.join('\n')}` : finalReply
  }
  if (notes.length) return notes.join('\n')
  return '[本轮没有留下交代]'
}

function truncateTextToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 4) return `${text.slice(0, 8)}…`
  if (estimateTokens(text) <= maxTokens) return text
  const ratio = text.length / Math.max(1, estimateTokens(text))
  const keepChars = Math.max(24, Math.floor(maxTokens * ratio * 0.9))
  if (text.length <= keepChars) return text
  const head = Math.floor(keepChars * 0.7)
  const tail = Math.max(8, keepChars - head)
  return `${text.slice(0, head)}\n…\n${text.slice(-tail)}`
}

/** 单条过长：先收工具正文，再收用户贴的大段，再收它写的长报告。 */
function fitOriginalMessages(messages: AiMessage[], maxTokens: number): AiMessage[] {
  const copy = omitHistoryImages(messages).map(m => ({ ...m }))
  if (estimateMessagesTokens(copy) <= maxTokens) return copy

  for (const msg of copy) {
    if (msg.role === 'tool' && msg.content) {
      msg.content = compressToolOutput(msg.content)
    }
  }
  if (estimateMessagesTokens(copy) <= maxTokens) return copy

  const user = copy.find(m => m.role === 'user')
  if (user && estimateTokens(user.content || '') > 80) {
    const other = estimateMessagesTokens(copy.filter(m => m !== user))
    user.content = truncateTextToTokens(user.content || '', Math.max(40, maxTokens - other))
  }
  if (estimateMessagesTokens(copy) <= maxTokens) return copy

  const asst = [...copy].reverse().find(m => m.role === 'assistant' && m.content && !m._systemInjected)
  if (asst) {
    const other = estimateMessagesTokens(copy.filter(m => m !== asst))
    asst.content = truncateTextToTokens(asst.content || '', Math.max(20, maxTokens - other))
  }
  return copy
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
  /**
   * 唤醒扫场：只要一句话概要，不走同一场原文。
   * 原文会把唤醒摘要区撑爆。
   */
  summaryOnly?: boolean
  /**
   * 本次请求的固定开销（system prompt + 工具 schema）实测值。
   * 传入后历史预算在「窗口减去它」的剩余空间里分配，避免超发。
   */
  fixedPrefixTokens?: number
}

// ==================== 核心构建函数 ====================

function countLevel(stats: ContextBuildResult['stats'], level: CompressionLevel): void {
  switch (level) {
    case 0: stats.level0Count++; break
    case 1: stats.level1Count++; break
    case 2: stats.level2Count++; break
    case 3: stats.level3Count++; break
    case 4: stats.level4Count++; break
  }
}

/**
 * 按预算构建最近任务上下文。
 * 同一场：从近到远装原文，装不下的更早整轮进可取回归档。
 * 唤醒：summaryOnly，只要一句话概要。
 */
export function buildRecentTasksContext(
  taskMemoryStore: TaskMemoryStore,
  budget: number,
  _userMessage?: string,
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

  const tasks = taskMemoryStore.getTasksInOrder()
  const taskLimit = options?.maxTasks ? Math.min(options.maxTasks, tasks.length) : tasks.length
  result.stats.totalTasks = taskLimit

  if (taskLimit === 0) return result

  if (options?.summaryOnly) {
    const slice = tasks.slice(0, taskLimit)
    result.taskSummarySection = slice.map(t => t.summary).join('\n\n')
    result.stats.level4Count = slice.length
    result.stats.usedTokens = estimateTokens(result.taskSummarySection)
    result.availableTaskIds = slice.map(t => ({ id: t.id, summary: t.summary }))
    return result
  }

  const RECALL_ROSTER_CAP = 50
  const rosterReserve = Math.min(RECALL_ROSTER_CAP, taskLimit) * 40
  const placeBudget = Math.max(0, budget - rosterReserve)

  type Placed = { task: TaskMemory; level: CompressionLevel; tokens: number; content: AiMessage[] }
  const placed: Placed[] = []
  let usedTokens = 0

  for (let i = 0; i < taskLimit; i++) {
    const task = tasks[i]
    let content = originalTaskMessages(task)
    let tokens = estimateMessagesTokens(content)
    if (usedTokens + tokens > placeBudget) {
      if (placed.length > 0) break
      const remaining = placeBudget - usedTokens
      if (remaining < 24) break
      content = fitOriginalMessages(content, remaining)
      tokens = estimateMessagesTokens(content)
      if (usedTokens + tokens > placeBudget) break
    }
    placed.push({ task, level: 0, tokens, content })
    usedTokens += tokens
  }

  const placedIds = new Set(placed.map(p => p.task.id))
  const unplaced = tasks.slice(0, taskLimit).filter(t => !placedIds.has(t.id)).reverse()
  const rosterTasks = [...unplaced, ...placed.map(p => p.task)].slice(0, RECALL_ROSTER_CAP)
  result.availableTaskIds = rosterTasks.map(t => ({
    id: t.id,
    summary: t.summary || t.userRequest
  }))
  let rosterTokens = estimateTokens(result.availableTaskIds.map(s => s.summary).join('\n'))
  while (result.availableTaskIds.length > 0 && usedTokens + rosterTokens > budget) {
    result.availableTaskIds.pop()
    rosterTokens = estimateTokens(result.availableTaskIds.map(s => s.summary).join('\n'))
  }

  result.stats.usedTokens = usedTokens + rosterTokens
  for (const item of placed) countLevel(result.stats, item.level)
  for (const item of [...placed].reverse()) {
    result.recentTaskMessages.push(...item.content)
  }
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
  const budget = calculateBudget(contextLength, options?.fixedPrefixTokens)
  return buildRecentTasksContext(taskMemoryStore, budget.recentTasks, userMessage, options)
}

