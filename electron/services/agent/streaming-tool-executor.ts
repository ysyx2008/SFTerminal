/**
 * 流式工具并行执行器
 *
 * 在模型流式输出过程中，一旦检测到完整的 tool_call 就立即开始执行，
 * 无需等待整个 assistant 消息输出完毕。只读工具可并行执行，
 * 有副作用的工具独占执行。
 *
 * 与 agent.ts 中既有的 PARALLELIZABLE_TOOLS + 批量并行逻辑互补：
 * - 既有逻辑：等 AI 输出结束后再按批次并行/串行
 * - 本执行器：AI 还在输出时就开始跑工具，缩短总等待时间
 */

import type { ToolCall } from '../ai.service'
import type { ToolResult, AgentRun } from './types'
import type { ToolExecutorConfig } from './tools/types'
import { executeTool } from './tools/index'
import { createLogger } from '../../utils/logger'

const log = createLogger('StreamingToolExecutor')

type ToolStatus = 'queued' | 'executing' | 'completed'

interface TrackedTool {
  toolCall: ToolCall
  status: ToolStatus
  isConcurrencySafe: boolean
  promise?: Promise<void>
  result?: ToolResult
  toolArgs: Record<string, unknown>
}

/**
 * 可并行执行的工具集合（只读、无副作用）
 * 与 Agent.PARALLELIZABLE_TOOLS 保持一致
 */
const CONCURRENCY_SAFE_TOOLS = new Set([
  'read_file',
  'file_search',
  'get_terminal_context',
  'check_terminal_status',
  'search_knowledge',
  'get_knowledge_doc',
  'recall',
  'recall_task',
  'deep_recall',
  'skill',
  'load_skill',
  'load_user_skill'
])

export interface StreamingToolExecutorOptions {
  run: AgentRun
  toolExecutorConfig: ToolExecutorConfig
  /** 可用工具名集合，用于检测幻觉工具 */
  availableToolNames: Set<string>
  /** 最大并行数 */
  maxConcurrency?: number
}

export interface CompletedToolResult {
  toolCall: ToolCall
  result: ToolResult
  toolArgs: Record<string, unknown>
}

export class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private executingCount = 0
  private aborted = false
  private readonly maxConcurrency: number
  private readonly run: AgentRun
  private readonly toolExecutorConfig: ToolExecutorConfig
  private readonly availableToolNames: Set<string>

  /** 解析器：当有工具完成时唤醒 getRemainingResults */
  private completionResolve?: () => void

  constructor(options: StreamingToolExecutorOptions) {
    this.run = options.run
    this.toolExecutorConfig = options.toolExecutorConfig
    this.availableToolNames = options.availableToolNames
    this.maxConcurrency = options.maxConcurrency ?? 10
  }

  /**
   * 添加一个完成的 tool_call 到执行队列。
   * 如果条件允许会立即开始执行。
   */
  addTool(toolCall: ToolCall): void {
    if (this.aborted) return

    let toolArgs: Record<string, unknown> = {}
    try {
      toolArgs = JSON.parse(toolCall.function.arguments)
    } catch {
      // JSON 解析失败 — 不应该到这里，调用方已校验
    }

    const isConcurrencySafe = CONCURRENCY_SAFE_TOOLS.has(toolCall.function.name)

    this.tools.push({
      toolCall,
      status: 'queued',
      isConcurrencySafe,
      toolArgs
    })

    this.processQueue()
  }

  /**
   * 获取目前已完成的工具结果（按添加顺序，只返回前缀连续已完成的部分）。
   * 已 yield 的结果不会再返回。
   */
  getCompletedResults(): CompletedToolResult[] {
    const results: CompletedToolResult[] = []
    while (this.tools.length > 0 && this.tools[0].status === 'completed') {
      const tracked = this.tools.shift()!
      results.push({
        toolCall: tracked.toolCall,
        result: tracked.result!,
        toolArgs: tracked.toolArgs
      })
    }
    return results
  }

  /**
   * 等待所有排队/执行中的工具完成，返回全部结果（按原始顺序）。
   * 在 AI 流式输出结束后调用。
   */
  async waitForAll(): Promise<CompletedToolResult[]> {
    // 等待所有 promise 完成
    while (this.tools.some(t => t.status !== 'completed')) {
      if (this.aborted) break
      await this.waitForCompletion()
    }
    return this.getCompletedResults()
  }

  /**
   * 标记为已中止。排队中的工具不再启动，正在执行的让其自然完成。
   */
  abort(): void {
    this.aborted = true
    this.wakeWaiters()
  }

  /**
   * 当前是否有工具在执行或排队
   */
  get hasPending(): boolean {
    return this.tools.some(t => t.status !== 'completed')
  }

  /**
   * 已添加的工具总数
   */
  get totalCount(): number {
    return this.tools.length
  }

  // ==================== 内部逻辑 ====================

  private processQueue(): void {
    if (this.aborted) return

    for (const tracked of this.tools) {
      if (tracked.status !== 'queued') continue

      if (!this.canExecute(tracked)) break

      this.startExecution(tracked)
    }
  }

  /**
   * 判断当前工具是否可以启动执行。
   * 规则：
   * 1. 如果有非安全工具正在执行，所有工具都要等待
   * 2. 非安全工具前面不能有任何排队/执行中的工具
   * 3. 安全工具可以与其他安全工具并行（不超过 maxConcurrency）
   */
  private canExecute(tracked: TrackedTool): boolean {
    if (this.executingCount >= this.maxConcurrency) return false

    // 有非安全工具正在执行 → 全部等待
    const hasUnsafeExecuting = this.tools.some(
      t => t.status === 'executing' && !t.isConcurrencySafe
    )
    if (hasUnsafeExecuting) return false

    if (tracked.isConcurrencySafe) {
      // 安全工具：只要没有非安全工具在执行就可以跑
      return true
    }

    // 非安全工具：必须没有任何工具在执行
    return this.executingCount === 0
  }

  private startExecution(tracked: TrackedTool): void {
    tracked.status = 'executing'
    this.executingCount++

    tracked.promise = this.executeOne(tracked)
      .finally(() => {
        // executeOne 内部已设置 tracked.result；此处做防御性兜底
        if (!tracked.result) {
          tracked.result = { success: false, output: '', error: 'Tool execution ended without result' }
        }
        tracked.status = 'completed'
        this.executingCount--
        this.wakeWaiters()
        this.processQueue()
      })
  }

  private async executeOne(tracked: TrackedTool): Promise<void> {
    const { toolCall } = tracked

    if (this.run.aborted || this.aborted) {
      tracked.result = { success: false, output: '', error: 'Operation aborted' }
      return
    }

    // 检测幻觉工具
    if (!this.availableToolNames.has(toolCall.function.name)) {
      log.warn(`Rejected hallucinated tool in streaming executor: ${toolCall.function.name}`)
      tracked.result = {
        success: false,
        output: '',
        error: `Unknown tool: ${toolCall.function.name}`
      }
      return
    }

    try {
      tracked.result = await executeTool(
        this.run.ptyId,
        toolCall,
        this.run.config,
        this.run.context.terminalOutput,
        this.toolExecutorConfig
      )
    } catch (err) {
      tracked.result = {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  private waitForCompletion(): Promise<void> {
    return new Promise<void>(resolve => {
      this.completionResolve = resolve
      // 安全超时：防止永久挂起
      setTimeout(() => {
        if (this.completionResolve === resolve) {
          this.completionResolve = undefined
          resolve()
        }
      }, 60_000)
    })
  }

  private wakeWaiters(): void {
    if (this.completionResolve) {
      const resolve = this.completionResolve
      this.completionResolve = undefined
      resolve()
    }
  }
}

/**
 * 检测 tool_call 的 arguments 是否是完整可解析的 JSON。
 * 流式中 arguments 是逐步拼接的字符串，只有完整 JSON 才意味着该 tool_call 已就绪。
 */
export function isToolCallComplete(toolCall: ToolCall): boolean {
  if (!toolCall.id || !toolCall.function.name || !toolCall.function.arguments) {
    return false
  }
  try {
    JSON.parse(toolCall.function.arguments)
    return true
  } catch {
    return false
  }
}
