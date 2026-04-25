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
 *
 * 工具的可清理性由 `ToolDefinition._meta.contextBudget.toolResult` 声明，
 * 调用方通过 `lookupMeta` 回调按需查询，本模块不知道任何具体工具名。
 */

import type { AiMessage } from '../ai.service'
import type { ToolMeta } from './tools'
import { createLogger } from '../../utils/logger'

const log = createLogger('ToolResultBudget')

export const CLEARED_PLACEHOLDER = '[旧工具输出已清理]'

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
 * 调用方注入的 ToolMeta 查询函数（按工具名查 _meta）。
 * 真实运行时由 agent.ts 提供 `(name) => getMetaByName(this.getAvailableTools(), name)`。
 */
export type LookupToolMeta = (toolName: string) => ToolMeta | undefined

/**
 * 判断一条 tool 消息是否可被清理
 *
 * 决策依据：
 * - 工具声明了 `_meta.contextBudget.toolResult: 'clearable'` → 清理
 * - 工具声明了 `_meta.contextBudget.toolResult: 'protected'` → 不清理
 * - 工具未声明（未知工具，多见于 MCP / plugin）→ 默认按可清理处理（与既有行为一致）
 */
function isClearableToolResult(
  toolMsg: AiMessage,
  toolNameMap: Map<string, string>,
  lookupMeta: LookupToolMeta,
  minChars: number
): boolean {
  if (toolMsg.role !== 'tool' || !toolMsg.tool_call_id) return false

  const content = toolMsg.content || ''
  if (content === CLEARED_PLACEHOLDER) return false
  if (content.length < minChars) return false

  const toolName = toolNameMap.get(toolMsg.tool_call_id)
  if (!toolName) return false

  const policy = lookupMeta(toolName)?.contextBudget?.toolResult
  if (policy === 'protected') return false
  if (policy === 'clearable') return true
  // 未声明：默认可清理（多见于 MCP / plugin 工具，它们的输出通常无副作用、可重取）
  return true
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
 * @param messages    - 当前 run.messages（会被就地修改）
 * @param lookupMeta  - 按工具名查 ToolMeta 的回调（通常包装 getMetaByName + getAvailableTools）
 * @param config      - 预算配置
 * @returns 清理统计
 */
export function applyToolResultBudget(
  messages: AiMessage[],
  lookupMeta: LookupToolMeta,
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
    if (isClearableToolResult(msg, toolNameMap, lookupMeta, cfg.minClearableChars)) {
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
