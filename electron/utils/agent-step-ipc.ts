/**
 * AgentStep IPC 序列化工具
 *
 * 主进程通过 IPC 向渲染进程推送 AgentStep 时，必须确保对象可结构化克隆。
 * 已知的不可序列化场景：
 *   - echartsOption.option 里混入了 ECharts 内部引用（罕见，但工具函数传过来时可能出现）
 *   - canvasData / subAgents 里含 Vue Proxy（从前端回流再转发时）
 *   - BigInt 出现在任意数值字段
 *   - 循环引用（工具 result 序列化不当时偶发）
 *
 * 策略：
 *   1. 先整体 JSON 往返（最快，过滤 undefined / 函数 / BigInt）
 *   2. 失败时降级：移除已知高风险字段，只保留 UI 必须字段后再序列化
 *   3. 仍失败则返回 null，调用方决定是否跳过该步骤
 */

import type { AgentStep } from '@shared/types'

/** JSON.stringify replacer：把不可序列化的值替换成安全的占位符 */
function safeReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function') return undefined
  return value
}

/**
 * 将 AgentStep 序列化为可安全通过 Electron IPC 传输的纯对象。
 * 返回 null 表示序列化彻底失败，调用方应丢弃该步骤。
 */
export function serializeAgentStepForIpc(step: AgentStep): AgentStep | null {
  // 快路径：绝大多数步骤可以直接往返
  try {
    return JSON.parse(JSON.stringify(step))
  } catch {
    // 降级：用 replacer 处理 BigInt / 函数
    try {
      return JSON.parse(JSON.stringify(step, safeReplacer))
    } catch {
      // 最后降级：剥离已知高风险字段，只保留核心展示字段
      try {
        const safe: Partial<AgentStep> = {
          id: step.id,
          type: step.type,
          content: step.content,
          toolName: step.toolName,
          toolCallId: step.toolCallId,
          toolResult: step.toolResult,
          hugeOutput: step.hugeOutput,
          riskLevel: step.riskLevel,
          timestamp: step.timestamp,
          isStreaming: step.isStreaming,
          success: step.success,
          contextTokens: step.contextTokens,
          cacheHitRate: step.cacheHitRate,
        }
        return JSON.parse(JSON.stringify(safe)) as AgentStep
      } catch {
        return null
      }
    }
  }
}
