/**
 * 工具结果预算管理
 * 
 * 在每轮 AI 调用前，对 run.messages 中旧的工具输出做预算检查。
 * 超预算的旧 tool 结果替换为占位文本，释放 token 给更有价值的上下文。
 * 
 * 设计原则（借鉴 Claude Code 的 applyToolResultBudget + microcompact）：
 * - 只处理"可清理工具"的输出（只读类工具），写入类工具不动
 * - 保护最近 N 轮的 tool 结果（工作焦点）
 * - taskMessageLog 保持不变（完整记录不受影响）
 * - 已清理的消息不会被重复清理（幂等），保护最近 N 轮的结果不被过早清理
 */

import type { AiMessage } from '../ai.service'
import { createLogger } from '../../utils/logger'

const log = createLogger('ToolResultBudget')

export const CLEARED_PLACEHOLDER = '[旧工具输出已清理]'

/** 可清理的工具名（只读类，输出可重新获取） */
const CLEARABLE_TOOLS = new Set([
  'read_file',
  'file_search',
  'execute_command',
  'get_terminal_context',
  'check_terminal_status',
  'search_knowledge',
  'get_knowledge_doc',
  'recall',
  'recall_task',
  'deep_recall',
])

/** 不可清理的工具名（写入类或关键信息，清理会丢失语义） */
const PROTECTED_TOOLS = new Set([
  'edit_file',
  'write_text_file',
  'write_remote_text_file',
  'ask_user',
  'plan',
  'create_plan',
  'update_plan',
  'remember_info',
  'compress_context',
  'recall_compressed',
  'manage_memory',
  'dispatch_agents',
])

interface BudgetConfig {
  /** 保护最近 N 轮 assistant+tool 对不被清理 */
  protectRecentRounds: number
  /** 单条 tool 输出超过此字符数才考虑清理（太短的清理收益低） */
  minClearableChars: number
}

const DEFAULT_CONFIG: BudgetConfig = {
  protectRecentRounds: 4,
  minClearableChars: 200,
}

export interface BudgetResult {
  /** 被清理的 tool 消息数 */
  clearedCount: number
  /** 释放的估算字符数 */
  freedChars: number
}

/**
 * 判断一条 tool 消息是否可被清理
 */
function isClearableToolResult(
  toolMsg: AiMessage,
  toolNameMap: Map<string, string>,
  minChars: number
): boolean {
  if (toolMsg.role !== 'tool' || !toolMsg.tool_call_id) return false

  const content = toolMsg.content || ''
  if (content === CLEARED_PLACEHOLDER) return false
  if (content.length < minChars) return false

  const toolName = toolNameMap.get(toolMsg.tool_call_id)
  if (!toolName) return false

  if (PROTECTED_TOOLS.has(toolName)) return false
  if (CLEARABLE_TOOLS.has(toolName)) return true

  // MCP/plugin 工具默认可清理
  if (toolName.startsWith('mcp_') || toolName.startsWith('plugin_')) return true

  return false
}

/**
 * 计算应该保护的消息范围（最近 N 轮 assistant+tool 对）
 * 返回需要保护的起始 index（该 index 及之后的消息不清理）
 */
function findProtectionBoundary(messages: AiMessage[], protectRounds: number): number {
  let roundCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      roundCount++
      if (roundCount >= protectRounds) {
        return i
      }
    }
  }
  return 0
}

/**
 * 构建 tool_call_id → 工具名 的映射表
 * 遍历所有 assistant 消息收集
 */
function buildToolNameMap(messages: AiMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        map.set(tc.id, tc.function.name)
      }
    }
  }
  return map
}

/**
 * 对 run.messages 执行工具结果预算清理
 * 
 * 直接修改 messages 数组中的 tool 消息内容（in-place），不影响 taskMessageLog。
 * 
 * @param messages - 当前 run.messages（会被就地修改）
 * @param config - 预算配置
 * @returns 清理统计
 */
export function applyToolResultBudget(
  messages: AiMessage[],
  config: Partial<BudgetConfig> = {}
): BudgetResult {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const result: BudgetResult = { clearedCount: 0, freedChars: 0 }

  if (messages.length === 0) return result

  // 找到第一条非 system 消息的位置（跳过 system prompt）
  let startIdx = 0
  while (startIdx < messages.length && messages[startIdx].role === 'system') {
    startIdx++
  }

  // 计算保护边界
  const protectionBoundary = findProtectionBoundary(messages, cfg.protectRecentRounds)

  // 构建全局 tool_call_id → 工具名映射
  const toolNameMap = buildToolNameMap(messages)

  // 遍历可清理范围内的消息
  for (let i = startIdx; i < protectionBoundary; i++) {
    const msg = messages[i]
    if (isClearableToolResult(msg, toolNameMap, cfg.minClearableChars)) {
      const originalLength = (msg.content || '').length
      msg.content = CLEARED_PLACEHOLDER
      result.clearedCount++
      result.freedChars += originalLength - CLEARED_PLACEHOLDER.length
    }
  }

  if (result.clearedCount > 0) {
    log.debug(`Tool result budget: cleared ${result.clearedCount} old tool outputs, freed ~${result.freedChars} chars`)
  }

  return result
}
