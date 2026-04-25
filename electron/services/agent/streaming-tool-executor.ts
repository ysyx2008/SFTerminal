/**
 * 流式工具并行执行器
 *
 * 在模型流式输出过程中，一旦检测到完整的 tool_call 就立即开始执行，
 * 无需等待整个 assistant 消息输出完毕。所有工具都经过完整安全链路
 * （plugin hooks、风险评估、用户确认），通过 Agent 注入的 executeFn 执行。
 *
 * 并发策略：只读工具可并行，有副作用的工具独占执行。
 * 结果处理：本执行器只负责执行和收集结果，消息历史写入由调用方按原始顺序完成。
 *
 * 与 agent.ts 中既有的 PARALLELIZABLE_TOOLS + 批量并行逻辑互补：
 * - 既有逻辑：等 AI 输出结束后再按批次并行/串行
 * - 本执行器：AI 还在输出时就开始跑工具，缩短总等待时间
 */

import type { ToolCall } from '../ai.service'
import type { ToolResult, AgentRun } from './types'
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
 * 工具执行函数签名（含安全检查：plugin hooks、风险评估、用户确认）。
 * 由 Agent 注入，StreamingToolExecutor 不直接依赖 Agent 内部实现。
 */
export type ToolExecuteFn = (toolCall: ToolCall) => Promise<{ result: ToolResult; toolArgs: Record<string, unknown> }>

export interface StreamingToolExecutorOptions {
  run: AgentRun
  /** 工具执行函数，包含完整安全链路 */
  executeFn: ToolExecuteFn
  /** 可用工具名集合，用于检测幻觉工具 */
  availableToolNames: Set<string>
  /**
   * 判断工具是否可并行执行（只读 / 无副作用）的回调。
   * 由调用方提供，本执行器不知道也不关心具体工具叫什么——
   * 真正的判定由 Agent 通过 ToolDefinition._meta.parallelizable 决定。
   * 不提供时默认全部串行（最保守）。
   */
  isConcurrencySafe?: (toolName: string) => boolean
  /** 最大并行数 */
  maxConcurrency?: number
  /**
   * 每个工具完成时立即触发的回调。用于在 AI 流式输出阶段"完成一个显示一个"
   * 地把 UI 卡片切到完成态（兜底 tool_result 步骤、回填 success），
   * 而不必等 AI 输出结束、再统一处理。回调内的异常不会影响后续工具调度。
   */
  onToolCompleted?: (result: CompletedToolResult) => void
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
  private readonly executeFn: ToolExecuteFn
  private readonly availableToolNames: Set<string>
  private readonly isConcurrencySafe: (toolName: string) => boolean
  private readonly onToolCompleted?: (result: CompletedToolResult) => void

  /** 解析器：当有工具完成时唤醒 getRemainingResults */
  private completionResolve?: () => void

  constructor(options: StreamingToolExecutorOptions) {
    this.run = options.run
    this.executeFn = options.executeFn
    this.availableToolNames = options.availableToolNames
    this.isConcurrencySafe = options.isConcurrencySafe ?? (() => false)
    this.maxConcurrency = options.maxConcurrency ?? 10
    this.onToolCompleted = options.onToolCompleted
  }

  /**
   * 添加一个完成的 tool_call 到执行队列。
   * 如果条件允许会立即开始执行。
   */
  addTool(toolCall: ToolCall): void {
    if (this.aborted) return

    this.tools.push({
      toolCall,
      status: 'queued',
      isConcurrencySafe: this.isConcurrencySafe(toolCall.function.name),
      toolArgs: {}
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
    if (this.aborted || this.run.aborted) return

    for (const tracked of this.tools) {
      if (tracked.status !== 'queued') continue

      if (!this.canExecute(tracked)) break

      this.startExecution(tracked)
    }
  }

  /**
   * 判断当前工具是否可以启动执行。
   * 规则：
   * 1. 安全工具可以与其他安全工具并行（不超过 maxConcurrency）
   * 2. 非安全工具独占执行（前面的必须全部完成）
   * 3. 有非安全工具正在执行时，所有工具都等待
   */
  private canExecute(tracked: TrackedTool): boolean {
    if (this.executingCount >= this.maxConcurrency) return false

    const hasUnsafeExecuting = this.tools.some(
      t => t.status === 'executing' && !t.isConcurrencySafe
    )
    if (hasUnsafeExecuting) return false

    if (tracked.isConcurrencySafe) return true

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

        // 完成即回填：让外部（Agent UI 层）立即看到 tool_result，无需等 waitForAll
        if (this.onToolCompleted) {
          try {
            this.onToolCompleted({
              toolCall: tracked.toolCall,
              result: tracked.result,
              toolArgs: tracked.toolArgs
            })
          } catch (err) {
            log.warn(`onToolCompleted handler threw: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

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
      const { result, toolArgs } = await this.executeFn(toolCall)
      tracked.result = result
      tracked.toolArgs = toolArgs
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
