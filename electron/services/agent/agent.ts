/**
 * Agent 抽象基类
 * 
 * 实现 Agent 的核心执行逻辑，子类（如 SailFish）实现特定行为。
 * 
 * 职责划分：
 * - Agent（基类）：执行循环、AI 交互、工具执行、步骤管理
 * - SailFish（子类）：工具列表管理、系统提示构建、可选终端能力
 */

import type { AiMessage, ToolCall, ChatWithToolsResult, ToolDefinition, RetryInfo } from '../ai.service'
import { StreamingToolExecutor } from './streaming-tool-executor'
import type { AgentRecord, AgentStepRecord } from '../history.service'
import type {
  AgentConfig,
  AgentStep,
  AgentContext,
  AgentPlan,
  AgentRun,
  AgentCallbacks,
  AgentServices,
  RunOptions,
  PromptOptions,
  KnowledgeContextResult,
  RunStatus,
  RiskLevel,
  TerminalType,
  ExecutionMode,
  AgentExecutionPhase,
  PendingConfirmationInternal,
  PendingSecureInputInternal,
  PendingUserMessage
} from './types'
import { DEFAULT_AGENT_CONFIG } from './types'
import { TaskMemoryStore } from './task-memory'
import { getBondService } from '../bond.service'
import type { ToolExecutorConfig, ToolResult } from './tools/types'
import { executeTool } from './tools/index'
import { stripToolMeta } from './tools'
import { getMetaByName, buildPreToolCallDisplay } from './tool-metadata'
import { buildTaskHistoryContext, type TaskHistoryOptions } from './context-builder'
import { getKnowledgeService } from '../knowledge'
import { getContextKnowledgeService } from '../knowledge/context-knowledge'
import { getWatchService } from '../watch/watch.service'
import { formatWatchListForPrompt } from './skills/watch/executor'
import { consumeProactiveContext } from './proactive-store'
import { applyToolResultBudget } from './tool-result-budget'
import { t } from './i18n'
import { createSkillSession, SkillSession } from './skills'
import { getAiDebugService } from '../ai-debug.service'
import { createLogger } from '../../utils/logger'
import { assembleUserMessageContent, wrapSystemContext } from './message-envelope'
import { notifyFrontendConfigChanged } from './skills/config/executor'

const log = createLogger('Agent')

/**
 * 去除流式输出中因 API 代理重复发送 reasoning_content 而产生的连续相同思考块。
 * 仅移除内容完全相同的相邻 <details> 块，保留不同的块。
 */
function deduplicateThinkingBlocks(html: string): string {
  const thinkingBlockRe = /(<details[^>]*>\s*<summary>[^<]*🤔[\s\S]*?<\/details>)\s*/g
  const blocks: { full: string; normalized: string; index: number }[] = []
  let match: RegExpExecArray | null
  while ((match = thinkingBlockRe.exec(html)) !== null) {
    blocks.push({ full: match[0], normalized: match[1].replace(/\s+/g, ' '), index: match.index })
  }
  if (blocks.length < 2) return html
  let result = html
  for (let i = blocks.length - 1; i > 0; i--) {
    if (blocks[i].normalized === blocks[i - 1].normalized) {
      result = result.slice(0, blocks[i].index) + result.slice(blocks[i].index + blocks[i].full.length)
    }
  }
  return result.trim() ? result : html
}

/**
 * Agent 抽象基类
 *
 * 注意：本基类不应硬编码任何具体工具名做行为分支。所有"按工具名差异化"的逻辑
 * 都通过 `ToolDefinition._meta`（声明在工具自己的定义上）+ `tool-metadata.ts`
 * 的 helper 完成查询，使基类对具体工具完全无感（OOP 抽象层不应穿透具体层）。
 *
 * 详见 SPEC.md「工具元数据驱动模型」一节。
 */
export abstract class Agent {
  // ==================== 配置（持久化） ====================
  
  /** 执行模式 */
  executionMode: ExecutionMode = 'strict'
  
  /** 命令超时时间（毫秒） */
  commandTimeout: number = 30000
  
  /** 调试模式 */
  debugMode: boolean = false
  
  /** AI 配置档案 ID（每个 Agent 实例独立，未设置时 fallback 到全局） */
  profileId?: string

  /** Agent 实例的逻辑 ID（用于路由 proactive message 等场景） */
  private _agentId?: string

  /**
   * 是否为「持久命名 Agent」（如 Companion / Watch 这类固定 ID、跨重启复用的 Agent）。
   *
   * 仅影响 `restoreFromHistory` 的全局历史 fallback：
   *   - true：sessionId 找不到 record 时，从全局最近 N 条历史提取任务恢复工作记忆
   *           （Companion/Watch 重启后第一次 run 用 `session_${Date.now()}` 找不到 record，
   *            必须靠这条 fallback 才能"记得最近聊过什么"）
   *   - false（默认）：普通 tab Agent 第一次对话本就是新任务，不应被全局历史污染，
   *           直接保持 TaskMemory 空白
   *
   * 由 `AgentService` 在创建命名 Agent 时通过 `markAsPersistentNamed()` 设置。
   */
  private _persistentNamedAgent: boolean = false
  
  // ==================== 状态（持久化） ====================
  
  /** 当前执行计划 */
  currentPlan?: AgentPlan
  
  /** 任务记忆存储 */
  protected taskMemory: TaskMemoryStore
  
  // ==================== 运行时 ====================
  
  /** 当前运行状态 */
  protected currentRun?: AgentRun

  /** run() 尚未进入 initializeRun 时收到的用户补充（前端已显示 isRunning） */
  private preRunUserMessages: PendingUserMessage[] = []
  
  /** 依赖服务 */
  protected services: AgentServices
  
  /** 事件回调 */
  protected callbacks?: AgentCallbacks
  
  /** ID 计数器 */
  private idCounter = 0
  
  /** 技能会话（Agent 实例级别，跨 Run 持久化） */
  private _skillSession?: SkillSession

  /** "始终允许"工具白名单（Agent 实例级别，跨 Run 持久化，重启后清空） */
  private allowedTools = new Set<string>()

  /** 上下文管理功能是否已激活（用量超过 50% 时启用） */
  protected contextManagementEnabled = false
  
  // ==================== 会话追踪（跨 Run 持久化） ====================
  
  /** 会话 ID */
  private _sessionId?: string
  
  /** 会话开始时间 */
  private _sessionStartTime?: number
  
  /** 会话内累积的所有 steps（跨多次 run） */
  private _sessionSteps: AgentStep[] = []
  
  /** 会话内累积的所有 API 消息（跨多次 run 的 taskMessageLog 合并） */
  private _sessionMessages: AiMessage[] = []
  
  /** 终端元数据（从首次 run 的 context 获取） */
  private _terminalMeta?: { terminalType: TerminalType; sshHost?: string }
  /** 是否正在从 HistoryService 恢复（防止并发竞态） */
  private _isRestoring = false

  /** 会话内累积的 token 用量（跨多次 run 汇总） */
  private _sessionTokenUsage?: import('@shared/types').TokenUsage

  /** 最近一次 API 调用返回的 prompt_tokens（用于精确的上下文压力估算） */
  private _lastPromptTokens?: number
  /** 最近一次 API 调用计算出的缓存命中率（0-100），用于跨步骤保持显示 */
  private _lastCacheHitRate?: number

  /** 上一次 run 结束时的完整 messages 快照（用于跨任务 prompt cache 复用）
   *  下一个 run 直接沿用此前缀 + 追加新 user 消息，使 LLM 的前缀缓存命中。 */
  private _previousRunMessages?: AiMessage[]
  
  // ==================== 构造函数 ====================
  
  constructor(services: AgentServices) {
    this.services = services
    this.taskMemory = this.createTaskMemory()
  }
  
  /**
   * 创建任务记忆存储（可被子类重写以支持测试 mock）。
   * 注入按工具名查 _meta 的回调，让 task-memory 能根据 lifecycle / argRole 决策行为，
   * 而不是硬编码具体工具名。回调内的 `this.getAvailableTools()` 在调用时才解析，
   * 此处构造时 subclass 还未完成初始化也没关系。
   */
  protected createTaskMemory(): TaskMemoryStore {
    return new TaskMemoryStore((name) => getMetaByName(this.getAvailableTools(), name))
  }

  /**
   * 设置 Agent 实例的逻辑 ID（由 AgentService.createAssistantAgent 调用）
   */
  setAgentId(id: string): void {
    this._agentId = id
  }

  /**
   * 标记为「持久命名 Agent」（Companion / Watch 这类固定 ID、跨重启复用的 Agent）。
   * 仅 AgentService 工厂方法调用，普通 tab Agent 不应调用此方法。
   * 详见字段注释 `_persistentNamedAgent`。
   */
  markAsPersistentNamed(): void {
    this._persistentNamedAgent = true
  }

  /**
   * 是否为持久命名 Agent（供测试和子类查询）。
   */
  isPersistentNamedAgent(): boolean {
    return this._persistentNamedAgent
  }

  
  /**
   * 获取技能会话（延迟初始化，Agent 实例级别持久化）
   * 技能加载状态会在多轮对话间保持
   */
  protected getSkillSession(): SkillSession {
    if (!this._skillSession) {
      this._skillSession = createSkillSession(this.getAvailableTools())
    }
    return this._skillSession
  }
  
  // ==================== 抽象方法（子类必须实现） ====================
  
  /**
   * 获取当前可用的工具列表
   */
  abstract getAvailableTools(): ToolDefinition[]
  
  /**
   * 构建系统提示词
   */
  protected abstract buildSystemPrompt(context: AgentContext, options: PromptOptions): string
  
  /**
   * 获取 Agent 标识（用于日志和调试）
   */
  protected abstract getAgentId(): string
  
  // ==================== 公开方法 ====================
  
  /**
   * 执行 Agent 任务
   */
  async run(message: string, context: AgentContext, options?: RunOptions): Promise<string> {
    // 检查是否已有运行中的任务
    if (this.currentRun?.isRunning) {
      throw new Error('Agent is already running')
    }
    
    // 如果传入了 profileId，更新 Agent 实例的配置
    if (options?.profileId) {
      this.profileId = options.profileId
    }

    // 清除上一轮 run 的缓存显示数据，避免跨 run 显示旧值（加载历史、切换模型等场景）
    this._lastCacheHitRate = undefined
    
    const run = this.initializeRun(message, context, options)
    const taskPreview = message.length > 80 ? message.slice(0, 80) + '...' : message
    log.info(`Task started: runId=${run.id}, ptyId=${run.ptyId}, mode=${this.executionMode}, task="${taskPreview}"`)
    const taskStartTime = Date.now()
    
    try {
      // 延迟解析 CWD：user_task 已发出，此时再刷新 CWD 不阻塞消息上墙
      if (options?.cwdResolver) {
        try {
          const cwd = await options.cwdResolver()
          run.context = { ...run.context, cwd }
        } catch (e) {
          log.warn('CWD resolve failed, using fallback:', e)
        }
      }
      
      await this.buildContext(run, message)
      let result = await this.executeLoop(run)
      // 主循环返回后用户可能刚补充消息：继续处理直至队列清空
      while (run.pendingUserMessages.length > 0 && !run.aborted) {
        result = await this.executeLoop(run)
      }
      this.finalizeRun(run, result)
      const elapsed = ((Date.now() - taskStartTime) / 1000).toFixed(1)
      log.info(`Task completed: runId=${run.id}, duration=${elapsed}s, steps=${run.steps.length}`)
      return result
    } catch (error) {
      this.handleError(run, error)
      const elapsed = ((Date.now() - taskStartTime) / 1000).toFixed(1)
      log.error(`Task failed: runId=${run.id}, duration=${elapsed}s, error=${error instanceof Error ? error.message : error}`)
      throw error
    } finally {
      this.cleanupRun(run)
    }
  }
  
  /**
   * 中止当前运行
   */
  abort(): boolean {
    if (!this.currentRun || !this.currentRun.isRunning) {
      return false
    }
    
    this.currentRun.aborted = true
    this.currentRun.isRunning = false

    // 释放待确认/安全输入等待，避免 abort 后 Promise 永久挂起、阻塞同实例下一次 run
    if (this.currentRun.pendingConfirmation) {
      const pending = this.currentRun.pendingConfirmation
      log.info(
        `[confirm] aborted while waiting (agent=${this._agentId ?? 'unknown'}, run=${this.currentRun.id}, tool=${pending.toolName}, toolCallId=${pending.toolCallId})`
      )
      this.currentRun.pendingConfirmation.resolve(false)
      this.currentRun.pendingConfirmation = undefined
    }
    if (this.currentRun.pendingSecureInput) {
      this.currentRun.pendingSecureInput.resolve(false)
      this.currentRun.pendingSecureInput = undefined
    }
    
    // 中止 AI 请求
    if (this.currentRun.requestId) {
      this.services.aiService.abort(this.currentRun.requestId)
    }
    
    return true
  }
  
  /**
   * 检查是否正在运行
   */
  isRunning(): boolean {
    return this.currentRun?.isRunning ?? false
  }
  
  /**
   * 更新配置
   */
  updateConfig(config: Partial<AgentConfig> & { profileId?: string }): void {
    if (config.executionMode !== undefined) {
      this.executionMode = config.executionMode
    }
    if (config.commandTimeout !== undefined) {
      this.commandTimeout = config.commandTimeout
    }
    if (config.debugMode !== undefined) {
      this.debugMode = config.debugMode
    }
    if (config.profileId !== undefined) {
      this.profileId = config.profileId
    }
    // 如果正在运行，也更新运行时配置
    if (this.currentRun) {
      Object.assign(this.currentRun.config, config)
    }
  }
  
  /**
   * 添加用户补充消息
   */
  addUserMessage(message: string, attachments?: import('@shared/types').AttachmentInfo[], documentContext?: string, images?: string[]): boolean {
    const pending: PendingUserMessage = {
      message,
      attachments: attachments?.length ? attachments : undefined,
      documentContext: documentContext || undefined,
      images: images?.length ? images : undefined
    }

    if (!this.currentRun?.isRunning) {
      // 前端已 setAgentRunning，但 run() 尚未 initializeRun — 先缓冲，initializeRun 时上墙
      this.preRunUserMessages.push(pending)
      return true
    }
    
    // 立即创建 user_supplement 步骤（追加到当前时间线末尾；流式输出会被 abort 打断，补充自然落在中断内容之后）
    this.addStep({
      type: 'user_supplement',
      content: message,
      attachments: attachments?.length ? attachments : undefined,
      images: images?.length ? images : undefined
    })
    
    this.currentRun.pendingUserMessages.push(pending)
    
    // 如果 Agent 正在等待（AI 思考中），中断当前请求让它处理新消息
    if (this.currentRun.executionPhase === 'thinking' && this.currentRun.requestId) {
      this.services.aiService.abort(this.currentRun.requestId)
    }
    
    return true
  }
  
  /**
   * 处理工具调用确认
   */
  confirmToolCall(
    toolCallId: string | undefined, 
    approved: boolean, 
    modifiedArgs?: Record<string, unknown>,
    alwaysAllow?: boolean
  ): boolean {
    const agentKey = this._agentId ?? 'unknown'
    const runId = this.currentRun?.id
    if (!this.currentRun || !this.currentRun.pendingConfirmation) {
      log.info(`[confirm] rejected: no pending (agent=${agentKey}, run=${runId}, toolCallId=${toolCallId ?? 'any'})`)
      return false
    }

    const pending = this.currentRun.pendingConfirmation
    if (toolCallId && pending.toolCallId !== toolCallId) {
      log.info(
        `[confirm] rejected: toolCallId mismatch (agent=${agentKey}, run=${runId}, expected=${pending.toolCallId}, got=${toolCallId})`
      )
      return false
    }

    log.info(
      `[confirm] resolved (agent=${agentKey}, run=${runId}, tool=${pending.toolName}, toolCallId=${pending.toolCallId}, approved=${approved}, alwaysAllow=${!!alwaysAllow})`
    )
    return this.resolvePendingConfirmation(approved, modifiedArgs, alwaysAllow)
  }

  /**
   * 确认当前待处理的工具调用（不要求 toolCallId，仅供 IM Companion 等单实例场景）。
   */
  confirmPendingToolCall(
    approved: boolean,
    modifiedArgs?: Record<string, unknown>,
    alwaysAllow?: boolean
  ): boolean {
    const agentKey = this._agentId ?? 'unknown'
    const runId = this.currentRun?.id
    if (!this.currentRun?.pendingConfirmation) {
      log.info(`[confirm] rejected: no pending (agent=${agentKey}, run=${runId}, via=pendingToolCall)`)
      return false
    }
    const pending = this.currentRun.pendingConfirmation
    log.info(
      `[confirm] resolved via pendingToolCall (agent=${agentKey}, run=${runId}, tool=${pending.toolName}, toolCallId=${pending.toolCallId}, approved=${approved})`
    )
    return this.resolvePendingConfirmation(approved, modifiedArgs, alwaysAllow)
  }

  private resolvePendingConfirmation(
    approved: boolean,
    modifiedArgs?: Record<string, unknown>,
    alwaysAllow?: boolean
  ): boolean {
    const pending = this.currentRun!.pendingConfirmation!
    if (approved && alwaysAllow) {
      const key = this.generateAllowedToolKey(pending.toolName, modifiedArgs || pending.toolArgs)
      this.allowedTools.add(key)
    }
    pending.resolve(approved, modifiedArgs)
    return true
  }
  
  /**
   * 是否有待确认的工具调用
   */
  hasPendingConfirmation(): boolean {
    return !!this.currentRun?.pendingConfirmation
  }

  /**
   * 解决安全输入请求（前端弹框用户完成输入后调用）。
   * @param requestId 请求 ID
   * @param saved true=用户已保存 key，false=用户取消
   */
  resolveSecureInput(requestId: string, saved: boolean): boolean {
    if (!this.currentRun?.pendingSecureInput) return false
    if (this.currentRun.pendingSecureInput.requestId !== requestId) return false
    this.currentRun.pendingSecureInput.resolve(saved)
    return true
  }

  /**
   * 是否有待处理的安全输入请求
   */
  hasPendingSecureInput(): boolean {
    return !!this.currentRun?.pendingSecureInput
  }

  /**
   * 获取运行状态
   */
  getRunStatus(): RunStatus | undefined {
    if (!this.currentRun) {
      return undefined
    }
    
    return {
      isRunning: this.currentRun.isRunning,
      phase: this.currentRun.executionPhase,
      currentToolName: this.currentRun.currentToolName,
      stepCount: this.currentRun.steps.length,
      hasPendingConfirmation: !!this.currentRun.pendingConfirmation
    }
  }
  
  /**
   * 获取当前执行阶段
   */
  getExecutionPhase(): AgentExecutionPhase {
    return this.currentRun?.executionPhase ?? 'idle'
  }
  
  /**
   * 设置回调
   */
  setCallbacks(callbacks: AgentCallbacks): void {
    this.callbacks = callbacks
  }
  
  /**
   * 清理资源
   */
  cleanup(): void {
    if (this.currentRun) {
      this.cleanupRun(this.currentRun)
      this.currentRun = undefined
    }
    
    // 清理技能会话
    if (this._skillSession) {
      this._skillSession.cleanup()
      this._skillSession = undefined
    }
  }
  
  // ==================== 受保护方法：生命周期 ====================
  
  /**
   * 初始化运行状态
   */
  protected initializeRun(message: string, context: AgentContext, options?: RunOptions): AgentRun {
    const runId = this.generateId()
    const config: AgentConfig = {
      ...DEFAULT_AGENT_CONFIG,
      executionMode: this.executionMode,
      commandTimeout: this.commandTimeout,
      debugMode: this.debugMode
    }
    
    const run: AgentRun = {
      id: runId,
      ptyId: context.ptyId,
      originalUserRequest: message,  // 保存原始用户请求，避免被历史消息覆盖
      messages: [],
      steps: [],
      isRunning: true,
      aborted: false,
      pendingUserMessages: [],
      config,
      context,
      realtimeOutputBuffer: [...context.terminalOutput],
      workerOptions: options?.workerOptions,
      executionPhase: 'thinking',
      skillSession: this.getSkillSession(),  // 使用 Agent 级别的技能会话，跨 Run 持久化
      taskMessageLog: []
    }
    
    this.currentRun = run
    
    // 注册运行级别回调
    if (options?.callbacks) {
      this.callbacks = options.callbacks
    }
    
    // 初始化会话追踪（首次 run 时创建 session 或从历史恢复）
    if (!this._sessionId) {
      if (context.sessionId) {
        this._sessionId = context.sessionId
        this._sessionStartTime = context.sessionStartTime || Date.now()
      } else {
        this._sessionId = `session_${Date.now()}`
        this._sessionStartTime = Date.now()
      }
      this._sessionSteps = []
      this._sessionMessages = []
    }
    
    // 记录终端元数据（从首次 run 的 context 获取）
    if (!this._terminalMeta) {
      this._terminalMeta = {
        terminalType: context.terminalType,
        sshHost: context.sshHost
      }
    }

    // 先推送 user_task 步骤，让用户消息立即上墙，再做耗时的初始化
    this.addStep({
      type: 'user_task',
      content: message,
      images: context.previewImages || context.images,
      attachments: context.attachments
    })

    // 准备阶段用户补充：run() IPC 往返期间缓冲的消息，紧跟 user_task 上墙
    if (this.preRunUserMessages.length > 0) {
      const queued = this.preRunUserMessages.splice(0)
      for (const supplement of queued) {
        run.pendingUserMessages.push(supplement)
        this.addStep({
          type: 'user_supplement',
          content: supplement.message,
          attachments: supplement.attachments,
          images: supplement.images
        })
      }
    }
    
    // 初始化 TaskMemory（仅首次 run 时，从 HistoryService 恢复）
    // 场景：用户恢复了历史对话，Agent 实例刚创建，TaskMemory 为空
    // 通过 sessionId 从 HistoryService 加载完整记录，避免前端反复传递大量数据
    if (this.taskMemory.getTaskCount() === 0 && this._sessionId && !this._isRestoring) {
      this._isRestoring = true
      try {
        this.restoreFromHistory()
      } finally {
        this._isRestoring = false
      }
    }
    
    // 添加初始步骤
    const initialStep = this.addStep({
      type: 'thinking',
      content: t('ai.preparing'),
      isStreaming: true
    })
    run.initialStepId = initialStep.id
    
    // 设置终端输出监听器
    this.setupOutputListener(run)
    
    return run
  }
  
  /**
   * 从 HistoryService 恢复 TaskMemory 和 session 步骤
   * 使用 sessionId 直接从后端存储加载，无需前端传递数据
   *
   * Fallback 策略（sessionId 找不到 record 时）：
   *   - 持久命名 Agent（Companion/Watch）：从全局最近历史恢复工作记忆
   *     —— 这些 Agent 重启后用 `session_${Date.now()}` 找不到 record，但语义上是
   *     「同一个长期 Agent」，需要记得最近聊过什么
   *   - 普通 tab Agent（terminal/独立助手）：直接返回，保持 TaskMemory 空白
   *     —— 新开 tab 的第一次对话本就是新任务，注入全局历史会让 AI 误以为是连续
   *     对话，沿用历史里的工具名（甚至当前 tab 工具表里没有的工具），造成幻觉调用
   */
  private restoreFromHistory(): void {
    const historyService = this.services.historyService
    if (!historyService || !this._sessionId) return
    
    const record = historyService.getAgentRecordById(this._sessionId)
    if (record) {
      this.restoreFromSessionRecord(record)
      return
    }

    if (!this._persistentNamedAgent) {
      log.info(`No record for sessionId=${this._sessionId}; skipping global recent fallback (not a persistent named agent)`)
      return
    }

    this.restoreRecentTaskMemory(historyService)
  }

  /**
   * 从精确匹配的 session 记录恢复完整状态（TaskMemory + session 追踪）
   * 场景：前端传回旧 sessionId，恢复之前的完整会话
   */
  private restoreFromSessionRecord(record: AgentRecord): void {
    if (record.messages && record.messages.length > 0) {
      const tasks = this.splitMessagesIntoTasks(record.messages as AiMessage[])
      for (const task of tasks) {
        this.taskMemory.saveTask(
          task.id,
          task.userTask,
          [],
          'success',
          task.finalResult,
          task.messages
        )
      }
      log.info(`Restored TaskMemory from session record: ${tasks.length} tasks (from messages)`)
    } else if (record.steps && record.steps.length > 0) {
      const tasks = this.splitStepsIntoTasks(record.steps)
      for (const task of tasks) {
        this.taskMemory.saveTask(
          task.id,
          task.userTask,
          task.steps,
          'success',
          task.finalResult
        )
      }
      log.info(`Restored TaskMemory from session record: ${tasks.length} tasks (from steps, no messages)`)
    }
    
    if (record.steps && record.steps.length > 0 && this._sessionSteps.length === 0) {
      this._sessionSteps = record.steps.map(s => ({
        id: s.id,
        type: s.type as AgentStep['type'],
        content: s.content,
        images: s.images,
        echartsOption: s.echartsOption,
        attachments: s.attachments,
        toolName: s.toolName,
        toolArgs: s.toolArgs,
        toolResult: s.toolResult,
        riskLevel: s.riskLevel as RiskLevel | undefined,
        timestamp: s.timestamp,
        webSearchResults: s.webSearchResults
      }))
    }
    
    if (record.messages && record.messages.length > 0 && this._sessionMessages.length === 0) {
      this._sessionMessages = (record.messages as AiMessage[]).map(m => ({ ...m }))
    }
  }

  /**
   * 从最近历史记录恢复工作记忆（仅 TaskMemory，不恢复 session 状态）
   * 场景：App 重启后 Companion 等命名 Agent 的首次 run，提取最近 5 个任务作为工作记忆
   */
  private restoreRecentTaskMemory(historyService: { getRecentAgentRecords(limit: number): AgentRecord[] }): void {
    const MAX_RECENT_TASKS = 5
    const MAX_RECENT_RECORDS = 3
    const recentRecords = historyService.getRecentAgentRecords(MAX_RECENT_RECORDS)
    if (recentRecords.length === 0) return

    const allTasks: Array<{ id: string; userTask: string; finalResult: string; messages?: AiMessage[]; steps?: AgentStep[] }> = []

    for (const rec of recentRecords) {
      if (rec.messages && rec.messages.length > 0) {
        const tasks = this.splitMessagesIntoTasks(rec.messages as AiMessage[])
        allTasks.push(...tasks)
      } else if (rec.steps && rec.steps.length > 0) {
        const tasks = this.splitStepsIntoTasks(rec.steps)
        allTasks.push(...tasks)
      }
    }

    if (allTasks.length === 0) return

    const recentTasks = allTasks.slice(-MAX_RECENT_TASKS)
    for (const task of recentTasks) {
      if (task.messages) {
        this.taskMemory.saveTask(task.id, task.userTask, [], 'success', task.finalResult, task.messages as AiMessage[])
      } else {
        this.taskMemory.saveTask(task.id, task.userTask, task.steps as AgentStep[] || [], 'success', task.finalResult)
      }
    }

    log.info(`Restored ${recentTasks.length} recent tasks from history (fallback, from ${recentRecords.length} records)`)
  }
  
  /**
   * 将连续的 API 消息按 user 消息分割为独立任务
   */
  private splitMessagesIntoTasks(messages: AiMessage[]): Array<{
    id: string; userTask: string; finalResult: string; messages: AiMessage[]
  }> {
    const tasks: Array<{ id: string; userTask: string; finalResult: string; messages: AiMessage[] }> = []
    let currentTaskMessages: AiMessage[] = []
    let currentUserTask = ''
    
    for (const msg of messages) {
      // 系统在 task 内部主动注入的 user 消息（如「工具读取图片占位」「上下文压力警告」）
      // 不构成任务边界，仅作为当前 task 的内部对话累积。
      const isRealUserBoundary = msg.role === 'user' && !msg._systemInjected

      if (isRealUserBoundary && currentTaskMessages.length > 0) {
        // 新的 user 消息 → 结束当前任务
        const lastAssistant = [...currentTaskMessages].reverse().find(
          m => m.role === 'assistant' && !m.tool_calls
        )
        tasks.push({
          id: `restored_${Date.now()}_${tasks.length}`,
          userTask: currentUserTask,
          finalResult: lastAssistant?.content || '',
          messages: currentTaskMessages
        })
        currentTaskMessages = []
      }

      if (isRealUserBoundary) {
        currentUserTask = msg.content || ''
      }

      currentTaskMessages.push(msg)
    }
    
    // 最后一组
    if (currentTaskMessages.length > 0) {
      const lastAssistant = [...currentTaskMessages].reverse().find(
        m => m.role === 'assistant' && !m.tool_calls
      )
      tasks.push({
        id: `restored_${Date.now()}_${tasks.length}`,
        userTask: currentUserTask,
        finalResult: lastAssistant?.content || '',
        messages: currentTaskMessages
      })
    }
    
    return tasks
  }
  
  /**
   * 从 steps 重建基本任务列表（降级路径：旧记录没有 messages 时使用）
   * 通过 user_task 和 final_result 步骤分割
   */
  private splitStepsIntoTasks(stepRecords: import('../history.service').AgentStepRecord[]): Array<{
    id: string; userTask: string; finalResult: string; steps: AgentStep[]
  }> {
    if (!stepRecords || stepRecords.length === 0) return []
    
    const tasks: Array<{ id: string; userTask: string; finalResult: string; steps: AgentStep[] }> = []
    let currentSteps: AgentStep[] = []
    let currentUserTask = ''
    const baseTs = stepRecords[0]?.timestamp || Date.now()
    
    for (const s of stepRecords) {
      // 注意：除 user_task 入口外，其它 record → step 重建路径（restoreFromSession /
      // saveSession / saveCheckpoint / forkSession）都已带富内容字段；此降级路径之前
      // 漏带 images / subAgents / success / echartsOption，导致仅有 steps 没有 messages
      // 的旧记录恢复时图表/子 Agent 卡片显示空白，本次一并补齐，与其它路径保持一致。
      const step: AgentStep = {
        id: s.id,
        type: s.type as AgentStep['type'],
        content: s.content,
        images: s.images,
        echartsOption: s.echartsOption,
        attachments: s.attachments,
        toolName: s.toolName,
        toolArgs: s.toolArgs,
        toolResult: s.toolResult,
        riskLevel: s.riskLevel as RiskLevel | undefined,
        timestamp: s.timestamp,
        webSearchResults: s.webSearchResults,
        success: s.success,
        subAgents: s.subAgents,
        canvasData: s.canvasData
      }
      
      if (s.type === 'user_task') {
        if (currentSteps.length > 0 && currentUserTask) {
          const lastFinal = [...currentSteps].reverse().find(st => st.type === 'final_result')
          tasks.push({
            id: `restored_${baseTs}_${tasks.length}`,
            userTask: currentUserTask,
            finalResult: lastFinal?.content || '',
            steps: currentSteps
          })
        }
        currentSteps = []
        currentUserTask = s.content || ''
      }
      
      currentSteps.push(step)
    }
    
    if (currentSteps.length > 0 && currentUserTask) {
      const lastFinal = [...currentSteps].reverse().find(st => st.type === 'final_result')
      tasks.push({
        id: `restored_${baseTs}_${tasks.length}`,
        userTask: currentUserTask,
        finalResult: lastFinal?.content || '',
        steps: currentSteps
      })
    }
    
    return tasks
  }
  
  /**
   * 完成运行，保存任务记忆
   */
  protected finalizeRun(run: AgentRun, result: string): void {
    run.isRunning = false

    // 补录最终 assistant 回复到完整对话日志
    // （纯文本回复不经过 executeStep 的 tool_calls 分支，不会被自动记录）
    // 思考模式：带上最近一次响应的 reasoning_content，避免下轮任务复用该消息时 DeepSeek V3.2+ 报错
    if (result != null) {
      const finalMsg: AiMessage = { role: 'assistant', content: result }
      if (run.lastAssistantReasoningContent !== undefined) {
        finalMsg.reasoning_content = run.lastAssistantReasoningContent
      }
      run.taskMessageLog.push(finalMsg)
    }
    
    // 先添加 final_result 步骤到 run.steps，确保后续保存包含完整数据
    if (result) {
      this.addStep({
        type: 'final_result',
        content: result
      })
    }
    
    // 保存任务到记忆（此时 run.steps 已包含 final_result）
    const status = run.aborted ? 'aborted' : 'success'
    
    this.taskMemory.saveTask(
      run.id,
      run.originalUserRequest,
      run.steps,
      status,
      result,
      run.taskMessageLog
    )

    // 保存 messages 快照供下一个任务复用（prompt cache 优化）
    // run.messages 不含最终纯文本回复（只有 tool_calls 时才 push），需要补上
    // 思考模式：保留 reasoning_content，确保下轮任务复用时 DeepSeek V3.2+ 不会因字段缺失拒绝
    const snapshot = run.messages.map(m => ({ ...m }))
    if (result != null) {
      const finalMsg: AiMessage = { role: 'assistant', content: result }
      if (run.lastAssistantReasoningContent !== undefined) {
        finalMsg.reasoning_content = run.lastAssistantReasoningContent
      }
      snapshot.push(finalMsg)
    }
    this._previousRunMessages = snapshot
    
    this.accumulateSessionData(run, status, result)
    this.saveSessionToHistory()

    // 诞生引导完成判定：调用了任何被标注 lifecycle.marksOnboardingComplete 的工具
    // 即视为引导完成（基类不知道具体是哪个工具，由 ToolDefinition._meta.lifecycle 声明）
    if (!(this.services.configService?.getAgentOnboardingCompleted())) {
      const tools = this.getAvailableTools()
      const onboardingMarkerCalled = run.steps.some(s => {
        if (s.type !== 'tool_call' || !s.toolName) return false
        return getMetaByName(tools, s.toolName)?.lifecycle?.marksOnboardingComplete === true
      })
      if (onboardingMarkerCalled) {
        this.services.configService?.setAgentOnboardingCompleted(true)
        notifyFrontendConfigChanged()
        log.info('Agent onboarding completed — onboarding-marker tool was called')
      }
    }
    
    // L2: 异步更新知识文档（唤醒 run 跳过，避免短问候污染知识文档）
    this.updateContextKnowledgeAsync(run, result).catch(err => {
      log.error('知识文档更新失败:', err)
    })

    // L3: 异步索引对话到向量库（供跨会话语义检索）
    this.indexConversationAsync(run, 'success', result).catch(err => {
      log.warn('对话向量索引失败:', err)
    })
    
    // 触发完成回调
    this.callbacks?.onComplete?.(run.id, result, run.pendingUserMessages.map(m => m.message))
  }
  
  // ==================== 会话持久化 ====================
  
  /**
   * 将单次 run 的数据累积到会话级别
   */
  private accumulateSessionData(run: AgentRun, _status: string, _result?: string): void {
    // run.steps 已包含 user_task、执行步骤和 final_result（由 addStep 统一管理）
    this._sessionSteps.push(...run.steps)
    
    // 累积 API 消息
    this._sessionMessages.push(...run.taskMessageLog)

    // 累积 token 用量（含缓存统计）
    if (run.tokenUsage) {
      if (!this._sessionTokenUsage) {
        this._sessionTokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }
      this._sessionTokenUsage.prompt_tokens += run.tokenUsage.prompt_tokens
      this._sessionTokenUsage.completion_tokens += run.tokenUsage.completion_tokens
      this._sessionTokenUsage.total_tokens += run.tokenUsage.total_tokens
      if (run.tokenUsage.cache_hit_tokens !== undefined) {
        this._sessionTokenUsage.cache_hit_tokens = (this._sessionTokenUsage.cache_hit_tokens || 0) + run.tokenUsage.cache_hit_tokens
      }
      if (run.tokenUsage.cache_miss_tokens !== undefined) {
        this._sessionTokenUsage.cache_miss_tokens = (this._sessionTokenUsage.cache_miss_tokens || 0) + run.tokenUsage.cache_miss_tokens
      }
    }
  }
  
  /**
   * 将会话数据保存到 HistoryService
   */
  private saveSessionToHistory(): void {
    const historyService = this.services.historyService
    if (!historyService || !this._sessionId || !this._sessionStartTime) return
    
    // 找到第一个 user_task 作为会话标题
    const firstUserTask = this._sessionSteps.find(s => s.type === 'user_task')
    if (!firstUserTask) return
    
    // 最后一个 final_result 的状态决定整个会话状态
    const lastFinalResult = [...this._sessionSteps].reverse().find(s => s.type === 'final_result')
    let status: 'completed' | 'failed' | 'aborted' = 'completed'
    // 根据 taskMemory 中最后一个任务的状态判断（比关键词匹配更准确）
    const lastTask = this.taskMemory.getSummaries(1)[0]
    if (lastTask) {
      if (lastTask.status === 'aborted') status = 'aborted'
      else if (lastTask.status === 'failed') status = 'failed'
    }
    
    // 序列化 steps
    const serializableSteps: AgentStepRecord[] = this._sessionSteps.map(s => ({
      id: s.id,
      type: s.type,
      content: s.content || '',
      images: s.images,
      echartsOption: s.echartsOption,
      attachments: s.attachments,
      toolName: s.toolName,
      toolArgs: s.toolArgs ? JSON.parse(JSON.stringify(s.toolArgs)) : undefined,
      toolResult: s.toolResult,
      riskLevel: s.riskLevel,
      timestamp: s.timestamp,
      webSearchResults: s.webSearchResults,
      success: s.success,
      subAgents: s.subAgents,
      canvasData: s.canvasData
    }))
    
    const record: AgentRecord = {
      id: this._sessionId,
      timestamp: this._sessionStartTime,
      terminalId: this.currentRun?.context.ptyId || '',
      terminalType: this._terminalMeta?.terminalType || 'local',
      sshHost: this._terminalMeta?.sshHost,
      userTask: firstUserTask.content,
      steps: serializableSteps,
      messages: this._sessionMessages.map(m => JSON.parse(JSON.stringify(m))),
      finalResult: lastFinalResult?.content,
      duration: Date.now() - this._sessionStartTime,
      status,
      tokenUsage: this._sessionTokenUsage
    }
    
    try {
      historyService.saveAgentRecord(record)
    } catch (err) {
      log.error('保存会话历史失败:', err)
    }
  }
  
  /**
   * 保存执行检查点：将当前 session + 进行中 run 的数据写入 HistoryService
   * 每完成一轮工具调用后自动触发，确保程序意外退出时不丢失对话记录
   */
  private saveCheckpoint(run: AgentRun): void {
    const historyService = this.services.historyService
    if (!historyService || !this._sessionId || !this._sessionStartTime) return
    
    // 合并：已累积的 session 步骤 + 当前 run 的执行步骤（已包含 user_task）
    const allSteps: AgentStep[] = [
      ...this._sessionSteps,
      ...run.steps
    ]
    const checkpointSteps: AgentStepRecord[] = allSteps.map(s => ({
      id: s.id,
      type: s.type,
      content: s.content || '',
      images: s.images,
      echartsOption: s.echartsOption,
      attachments: s.attachments,
      toolName: s.toolName,
      toolArgs: s.toolArgs ? JSON.parse(JSON.stringify(s.toolArgs)) : undefined,
      toolResult: s.toolResult,
      riskLevel: s.riskLevel,
      timestamp: s.timestamp,
      webSearchResults: s.webSearchResults,
      success: s.success,
      subAgents: s.subAgents,
      canvasData: s.canvasData
    }))
    
    // 合并 API 消息
    const checkpointMessages = [...this._sessionMessages, ...run.taskMessageLog]
    
    const firstUserTask = this._sessionSteps.find(s => s.type === 'user_task') || { content: run.originalUserRequest }
    
    // 合并 session 和当前 run 的 token 用量（含缓存统计）
    let checkpointTokenUsage = this._sessionTokenUsage
    if (run.tokenUsage) {
      checkpointTokenUsage = {
        prompt_tokens: (checkpointTokenUsage?.prompt_tokens || 0) + run.tokenUsage.prompt_tokens,
        completion_tokens: (checkpointTokenUsage?.completion_tokens || 0) + run.tokenUsage.completion_tokens,
        total_tokens: (checkpointTokenUsage?.total_tokens || 0) + run.tokenUsage.total_tokens,
        ...(run.tokenUsage.cache_hit_tokens !== undefined || checkpointTokenUsage?.cache_hit_tokens !== undefined
          ? { cache_hit_tokens: (checkpointTokenUsage?.cache_hit_tokens || 0) + (run.tokenUsage.cache_hit_tokens || 0) }
          : {}),
        ...(run.tokenUsage.cache_miss_tokens !== undefined || checkpointTokenUsage?.cache_miss_tokens !== undefined
          ? { cache_miss_tokens: (checkpointTokenUsage?.cache_miss_tokens || 0) + (run.tokenUsage.cache_miss_tokens || 0) }
          : {})
      }
    }

    const record: AgentRecord = {
      id: this._sessionId,
      timestamp: this._sessionStartTime,
      terminalId: run.context.ptyId || '',
      terminalType: this._terminalMeta?.terminalType || 'local',
      sshHost: this._terminalMeta?.sshHost,
      userTask: firstUserTask.content,
      steps: checkpointSteps,
      messages: checkpointMessages.map(m => JSON.parse(JSON.stringify(m))),
      duration: Date.now() - this._sessionStartTime,
      status: 'completed',  // 检查点视为进行中但有效的记录
      tokenUsage: checkpointTokenUsage
    }
    
    try {
      historyService.saveAgentRecord(record)
    } catch (err) {
      log.error('保存检查点失败:', err)
    }
  }
  
  // ==================== Fork（另开一聊） ====================

  /**
   * 获取当前 session ID（fork 时给 AgentService 用，判断源 Agent 是否有可分叉的会话）
   */
  getSessionId(): string | undefined {
    return this._sessionId
  }

  /**
   * 获取终端模式元数据（fork 时给 AgentService 用，判断是否同模式以决定 cache snapshot 是否传递）
   */
  getTerminalType(): TerminalType | undefined {
    return this._terminalMeta?.terminalType
  }

  /**
   * 为 fork 生成截断后的新 AgentRecord。
   *
   * 实现要点：
   * - 直接基于 in-memory 的 _sessionMessages / _sessionSteps 构造，不读 HistoryService
   *   （source Agent 总是持有最新状态，HistoryService 中可能略滞后）
   * - 截断按 task 边界（user_task step / 真实 user message）进行，task 内部的 tool_calls
   *   配对天然完整，不会破坏 LLM API 协议
   * - 返回的 record 还未写入 HistoryService，由调用方负责 saveAgentRecord
   *
   * @param newSessionId 新 session ID（由调用方生成）
   * @param opts.untilTaskCount 截断到第 N 个 task（包含），undefined / >= 总数 = 不截断
   * @param opts.titleSuffix userTask 后缀（如「· 分支」）
   */
  cloneRecordForFork(
    newSessionId: string,
    opts?: { untilTaskCount?: number; titleSuffix?: string }
  ): AgentRecord | null {
    if (!this._sessionId) return null

    let messages = this._sessionMessages.map(m => JSON.parse(JSON.stringify(m))) as AiMessage[]
    let steps = [...this._sessionSteps]

    if (opts?.untilTaskCount !== undefined && opts.untilTaskCount > 0) {
      const tasks = this.splitMessagesIntoTasks(messages)
      if (opts.untilTaskCount < tasks.length) {
        messages = tasks.slice(0, opts.untilTaskCount).flatMap(t => t.messages)
      }

      const stepChunks = this.splitSessionStepsByUserTask(steps)
      if (opts.untilTaskCount < stepChunks.length) {
        steps = stepChunks.slice(0, opts.untilTaskCount).flat()
      }
    }

    const firstUserTask = steps.find(s => s.type === 'user_task')
    if (!firstUserTask) return null

    const lastFinalResult = [...steps].reverse().find(s => s.type === 'final_result')

    const serializableSteps: AgentStepRecord[] = steps.map(s => ({
      id: s.id,
      type: s.type,
      content: s.content || '',
      images: s.images,
      echartsOption: s.echartsOption,
      attachments: s.attachments,
      toolName: s.toolName,
      toolArgs: s.toolArgs ? JSON.parse(JSON.stringify(s.toolArgs)) : undefined,
      toolResult: s.toolResult,
      riskLevel: s.riskLevel,
      timestamp: s.timestamp,
      webSearchResults: s.webSearchResults,
      success: s.success,
      subAgents: s.subAgents,
      canvasData: s.canvasData
    }))

    const titleSuffix = opts?.titleSuffix ?? ''
    return {
      id: newSessionId,
      timestamp: Date.now(),
      terminalId: '',
      terminalType: this._terminalMeta?.terminalType || 'local',
      sshHost: this._terminalMeta?.sshHost,
      userTask: firstUserTask.content + titleSuffix,
      steps: serializableSteps,
      messages,
      finalResult: lastFinalResult?.content,
      duration: 0,
      status: 'completed'
    }
  }

  /**
   * 按 user_task step 切分会话步骤（每个 chunk 是一个 task 的所有步骤）
   * 用于 fork 时截断到第 N 个 task
   *
   * 前置条件：steps 的第一个元素必须是 user_task —— 由 initializeRun() 保证
   * （它在 run.steps 上推入的第一条永远是 type='user_task'）。如果未来允许
   * 在 user_task 之前注入任何 step，会导致第一个 chunk 不以 user_task 开头，
   * 进而让 untilTaskCount 的 1-based 语义错位。
   */
  private splitSessionStepsByUserTask(steps: AgentStep[]): AgentStep[][] {
    const chunks: AgentStep[][] = []
    let current: AgentStep[] = []
    for (const s of steps) {
      if (s.type === 'user_task' && current.length > 0) {
        chunks.push(current)
        current = []
      }
      current.push(s)
    }
    if (current.length > 0) chunks.push(current)
    return chunks
  }

  /**
   * 装载 fork 数据到新 Agent 实例上。
   *
   * - sessionId：必须，让首次 run 走 restoreFromHistory(sessionId) 路径而非生成新 id
   * - previousRunMessages：可选 cache snapshot。同模式 fork 时由 AgentService.forkAgent
   *   直接用 newRecord.messages（与新 record 字节一致）传入，让下次 run 命中 LLM 前缀缓存；
   *   跨模式不传，新 Agent 走 cold start 从 record 重建上下文
   */
  applyForkSnapshot(opts: {
    sessionId: string
    previousRunMessages?: AiMessage[]
  }): void {
    this._sessionId = opts.sessionId
    this._sessionStartTime = Date.now()
    this._sessionSteps = []
    this._sessionMessages = []
    if (opts.previousRunMessages && opts.previousRunMessages.length > 0) {
      // AiMessage 含 tool_calls 等嵌套数组，必须深拷贝避免与源 Agent 共享引用
      this._previousRunMessages = opts.previousRunMessages.map(m => JSON.parse(JSON.stringify(m))) as AiMessage[]
    }
  }

  /**
   * 重置会话状态（前端"新对话"或终端重连时调用）
   */
  resetSession(): void {
    this.preRunUserMessages = []
    this._sessionId = undefined
    this._sessionStartTime = undefined
    this._sessionSteps = []
    this._sessionMessages = []
    this._sessionTokenUsage = undefined
    this._lastPromptTokens = undefined
    this._lastCacheHitRate = undefined
    this._terminalMeta = undefined
    this._previousRunMessages = undefined
    this.taskMemory.clear()
  }

  /**
   * 开始新的持久化会话（下次 run 时使用新 sessionId 创建独立 AgentRecord）
   * 与 resetSession 不同：保留 TaskMemory（工作记忆），仅重置 session 追踪
   * 用途：Watch 每次执行需要独立的历史记录，但 Agent 需要记住之前做过什么
   */
  startNewSession(): void {
    this._sessionId = undefined
    this._sessionStartTime = undefined
    this._sessionSteps = []
    this._sessionMessages = []
    this._sessionTokenUsage = undefined
    this._lastPromptTokens = undefined
    this._lastCacheHitRate = undefined
  }

  
  /**
   * L2: 异步更新知识文档
   * 收集执行记录，交给 LLM 判断是否有值得持久化的新信息
   */
  private async updateContextKnowledgeAsync(run: AgentRun, result?: string): Promise<void> {
    const aiService = this.services.aiService
    if (!aiService) return

    // 唤醒 run 跳过（短问候不产生值得持久化的系统知识）
    if (run.context.wakeup) return

    // 跳过纯对话（没有执行过工具的任务不太可能产生新的系统知识）
    const toolSteps = run.steps.filter(s => s.type === 'tool_call' && s.toolName)
    if (toolSteps.length === 0) return

    const contextId = run.context.hostId || 'personal'
    const MAX_ARG_DISPLAY = 200
    const MAX_RESULT_DISPLAY = 300
    const MAX_FINAL_RESULT_DISPLAY = 500
    
    const commandRecords: string[] = []
    for (const step of run.steps) {
      if (step.type === 'tool_call' && step.toolName && step.toolArgs) {
        const argsStr = Object.entries(step.toolArgs)
          .map(([k, v]) => {
            let str: string
            if (typeof v === 'string') {
              str = v
            } else {
              try { str = JSON.stringify(v) ?? String(v) } catch { str = String(v) }
            }
            return `${k}=${str.substring(0, MAX_ARG_DISPLAY)}`
          })
          .join(', ')
        commandRecords.push(`[${step.toolName}] ${argsStr}`)
      }
      if (step.type === 'tool_result' && step.toolName && step.toolResult) {
        commandRecords.push(`  → ${step.toolResult.substring(0, MAX_RESULT_DISPLAY)}`)
      }
    }
    
    if (result) {
      commandRecords.push(`\n最终结果: ${result.substring(0, MAX_FINAL_RESULT_DISPLAY)}`)
    }
    
    if (commandRecords.length === 0) return

    const ckService = getContextKnowledgeService()
    const profileId = this.services.configService?.getActiveAiProfile() ?? undefined
    
    await ckService.updateWithLLM(contextId, aiService, profileId, {
      userRequest: run.originalUserRequest,
      commandRecords
    })
  }

  /**
   * L3: 将对话摘要异步索引到向量库，供跨会话语义检索
   */
  private async indexConversationAsync(
    run: AgentRun,
    status: 'success' | 'failed' | 'aborted',
    result?: string
  ): Promise<void> {
    if (!run.originalUserRequest?.trim()) return

    // 唤醒 run 跳过（"你好"之类的短问候不值得索引）
    if (run.context.wakeup) return

    const knowledgeService = getKnowledgeService()
    if (!knowledgeService || !knowledgeService.isEnabled()) return

    const hostId = run.context.hostId || 'personal'

    await knowledgeService.indexConversation({
      taskId: run.id,
      hostId,
      userRequest: run.originalUserRequest,
      finalResult: result || '',
      status,
      timestamp: Date.now()
    })
  }
  
  /**
   * 清理运行资源
   * 注意：技能会话在 Agent 实例级别维护，不在单次 Run 结束时清理
   */
  protected cleanupRun(run: AgentRun): void {
    // 取消输出监听
    if (run.outputUnsubscribe) {
      run.outputUnsubscribe()
      run.outputUnsubscribe = undefined
    }
    
    // 技能会话已提升到 Agent 实例级别，这里不再清理
    // 技能会话会在 Agent.cleanup() 中统一清理
    
    run.isRunning = false
  }
  
  /**
   * 处理运行错误
   *
   * 维护对话记录的对称性：成功路径（finalizeRun）会把最终 assistant 回复追加到
   * taskMessageLog 与 _previousRunMessages，失败路径必须做同样的事，否则下次任务：
   *   • cache path：复用上一次成功 run 的快照，整个失败任务的消息被沉默丢弃，
   *                 AI 完全不知道用户上条消息存在过，无法做错误恢复
   *   • cold start：TaskMemory 中的 messages 缺最终 assistant 回复，AI 看到工具
   *                 调用历史后突然到下一个用户消息，无法理解为什么没有回复
   */
  protected handleError(run: AgentRun, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error)

    this.addStep({
      type: 'error',
      content: errorMessage
    })

    // 修复运行抛错时可能遗留的悬空 tool_calls：assistant 已宣告调用工具但 tool result
    // 还没产生（典型场景：工具执行中崩溃、AI 流式输出后调下一轮 API 时网络超时）。
    // fixIncompleteToolCalls 会同步补占位到 run.messages 与 run.taskMessageLog
    this.fixIncompleteToolCalls(run, `[执行中断: ${errorMessage}]`)

    // 把错误作为一条 assistant 回复追加到对话日志（与 finalizeRun 的成功路径对称）
    const errorAssistantMsg: AiMessage = {
      role: 'assistant',
      content: `❌ ${errorMessage}`
    }
    if (run.lastAssistantReasoningContent !== undefined) {
      errorAssistantMsg.reasoning_content = run.lastAssistantReasoningContent
    }
    run.messages.push(errorAssistantMsg)
    run.taskMessageLog.push({ ...errorAssistantMsg })

    // 添加 final_result 步骤（错误时也统一由后端生成，❌ 前缀供前端区分成功/失败）
    this.addStep({
      type: 'final_result',
      content: `❌ ${errorMessage}`
    })

    // 保存失败的任务（此时 taskMessageLog 已包含完整的失败现场，含错误回复）
    this.taskMemory.saveTask(
      run.id,
      run.originalUserRequest,
      run.steps,
      'failed',
      errorMessage,
      run.taskMessageLog
    )

    // 更新 prompt cache 快照：让下个任务的 cache path 看到失败现场，
    // 而不是沿用更早一次成功 run 的快照（导致整个失败任务被遗忘）。
    // 仅当 run.messages 至少包含一条 user 消息时才更新——否则说明 buildContext
    // 阶段就抛错了（system/user 都没装入），用这种半成品快照会让下次任务复用
    // 一段无 system 无 user 的不合法序列。这种异常情况让 _previousRunMessages
    // 保持原值（上次成功 run），下次任务走 cold start 重建即可。
    const hasUserMessage = run.messages.some(m => m.role === 'user')
    if (hasUserMessage) {
      this._previousRunMessages = run.messages.map(m => ({ ...m }))
    }

    this.accumulateSessionData(run, 'failed', errorMessage)
    this.saveSessionToHistory()

    // L3: 异步索引失败的对话（失败经验同样有检索价值）
    this.indexConversationAsync(run, 'failed', errorMessage).catch(err => {
      log.warn('对话向量索引失败:', err)
    })

    this.callbacks?.onError?.(run.id, errorMessage)
  }
  
  // ==================== 受保护方法：上下文构建 ====================
  
  /**
   * 构建执行上下文
   */
  protected async buildContext(run: AgentRun, message: string): Promise<void> {
    // ── Cache-optimized path ──
    // 同一 session 内，直接沿用上一个任务的完整 messages 作为前缀，只追加新 user 消息。
    // LLM 的前缀缓存（Anthropic explicit / DeepSeek·OpenAI automatic）可命中整段前缀。
    // 跳过条件：首次任务、唤醒 run（Watch 等，上下文差异大）、上下文预算不足。
    if (this._previousRunMessages && this._previousRunMessages.length > 0 && !run.context.wakeup) {
      const contextLength = this.getContextLength()
      const prevTokens = this._lastPromptTokens || this.estimateTotalTokens(this._previousRunMessages)

      if (prevTokens < contextLength * 0.7) {
        // 复用前序消息，清除旧的缓存断点标记
        run.messages = this._previousRunMessages.map(m => {
          const copy = { ...m }
          delete copy._cacheBreakpoint
          return copy
        })

        // 在前序消息末尾设置 Anthropic cache breakpoint（第 3 个断点）
        const lastPrevMsg = run.messages[run.messages.length - 1]
        if (lastPrevMsg) {
          lastPrevMsg._cacheBreakpoint = true
        }

        // 组装新 user 消息（知识检索结果注入到 user 消息前缀，而非 system prompt）
        const userMsg = await this.buildUserMessage(run, message, true)
        run.messages.push(userMsg)
        run.taskMessageLog.push({ ...userMsg })

        log.info(`[Cache] Reusing ${this._previousRunMessages.length} messages (~${prevTokens} tokens, ${Math.round(prevTokens / contextLength * 100)}% of context)`)
        return
      }

      log.info(`[Cache] Reuse skipped: ~${prevTokens} tokens exceed 70% of ${contextLength} context`)
    }

    // ── Cold start path: 从零构建上下文 ──

    // 提前并行启动两个异步操作（均需 embedding + 向量搜索，相互独立）
    const knowledgeResultPromise = this.loadKnowledgeContext(message, run.context.hostId)

    const L3_RECALL_TIMEOUT_MS = 3000
    const recallPromise: Promise<Array<{ userRequest: string; finalResult: string; status: string; timestamp: number; relevance: number }>> = (() => {
      const ks = getKnowledgeService()
      if (!ks || !ks.isEnabled() || message.trim().length < 5) return Promise.resolve([])
      const searchPromise = ks.searchConversations(message, run.context.hostId, 3)
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('L3 recall timeout')), L3_RECALL_TIMEOUT_MS)
      )
      return Promise.race([searchPromise, timeoutPromise])
        .then(results => results.map(r => ({
          userRequest: r.userRequest,
          finalResult: r.finalResult,
          status: r.status,
          timestamp: r.timestamp,
          relevance: r.relevance ?? 0
        })))
        .catch(e => {
          log.warn('L3 auto-recall error:', e)
          return []
        })
    })()

    // 同步操作在异步请求进行期间并发执行
    let taskSummaries = ''
    let relatedTaskDigests = ''
    let recentTaskMessages: AiMessage[] = []
    let availableTaskIds: Array<{ id: string; summary: string }> = []
    
    if (this.taskMemory.getTaskCount() > 0) {
      const contextLength = this.getContextLength()
      const historyOptions: TaskHistoryOptions | undefined = run.context.wakeup
        ? { maxTasks: 5, minCompressionLevel: 3 }
        : undefined
      const contextResult = buildTaskHistoryContext(this.taskMemory, contextLength, message, historyOptions)
      
      recentTaskMessages = contextResult.recentTaskMessages
      if (contextResult.taskSummarySection) {
        taskSummaries = contextResult.taskSummarySection
      }
      availableTaskIds = contextResult.availableTaskIds
      
      const relatedDigests = this.taskMemory.getRelatedDigests(message, 3)
      if (relatedDigests.length > 0) {
        relatedTaskDigests = this.taskMemory.formatRelatedDigestsForContext(relatedDigests)
      }
    }
    
    let contextKnowledgeDoc = ''
    const contextId = run.context.hostId || 'personal'
    try {
      const ckService = getContextKnowledgeService()
      contextKnowledgeDoc = ckService.getDocument(contextId)
    } catch (e) {
      log.warn('ContextKnowledge load error:', e)
    }

    let watchListSummary = ''
    try {
      const watches = getWatchService().getAll()
      watchListSummary = formatWatchListForPrompt(watches)
    } catch (e) {
      log.warn('Watch list for prompt error:', e)
    }

    // 等待两个异步操作同时完成
    const [knowledgeResult, conversationHistory] = await Promise.all([knowledgeResultPromise, recallPromise])

    const isOnboarding = !(this.services.configService?.getAgentOnboardingCompleted() ?? true)

    const promptOptions: PromptOptions = {
      mbtiType: this.services.configService?.getAgentMbti() ?? undefined,
      knowledgeContext: knowledgeResult.context,
      knowledgeEnabled: knowledgeResult.enabled,
      conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
      contextKnowledgeDoc,
      aiRules: this.services.configService?.getAiRules() ?? '',
      agentName: this.services.configService?.getAgentName() ?? '',
      taskSummaries,
      relatedTaskDigests,
      availableTaskIds,
      watchListSummary: watchListSummary || undefined,
      bondContext: this.resolveBondContext(),
      isOnboarding,
    }
    
    const systemPrompt = this.buildSystemPrompt(run.context, promptOptions)
    run.messages.push({ role: 'system', content: systemPrompt })
    
    if (recentTaskMessages.length > 0) {
      for (const msg of recentTaskMessages) {
        run.messages.push(msg)
      }
    }

    const userMsg = await this.buildUserMessage(run, message, false)
    run.messages.push(userMsg)
    run.taskMessageLog.push({ ...userMsg })
  }

  /**
   * 组装增强后的用户消息
   * @param injectKnowledge cache-reuse 路径下，知识检索结果不在 system prompt 中，需注入到 user 消息
   */
  private async buildUserMessage(run: AgentRun, message: string, injectKnowledge: boolean): Promise<AiMessage> {
    const userBody = this.enhanceUserMessage(message)

    let knowledgeRefs = ''
    if (injectKnowledge) {
      const knowledgeResult = await this.loadKnowledgeContext(message, run.context.hostId)
      knowledgeRefs = knowledgeResult.context
    }

    const systemContextParts: string[] = []
    if (run.context.contextHint?.trim()) {
      systemContextParts.push(run.context.contextHint.trim())
    }
    const proactiveCtx = run.context.proactiveContext
      || (this._agentId ? consumeProactiveContext(this._agentId) : undefined)
    if (proactiveCtx?.trim()) {
      systemContextParts.push(proactiveCtx.trim())
    }
    const hasImages = !!(run.context.images && run.context.images.length > 0)
    const visionAvailable = this.currentProfileHasVision()
    let imageNote = ''
    if (hasImages) {
      const imageCount = run.context.images!.length
      const totalSize = run.context.images!.reduce((sum, img) => sum + img.length, 0)
      log.info(`User images: ${imageCount} image(s), total base64 size: ${(totalSize / 1024).toFixed(0)}KB, vision=${visionAvailable}`)
      if (visionAvailable) {
        imageNote = t('agent.images_attached', { count: imageCount })
      } else {
        log.warn(`Dropping ${imageCount} user image(s) due to no vision capability on current profile`)
        imageNote = t('agent.user_image_no_vision', { count: imageCount })
      }
    }

    const enhancedMessage = assembleUserMessageContent({
      knowledgeRefs,
      systemContext: systemContextParts.length > 0 ? wrapSystemContext(systemContextParts.join('\n\n')) : undefined,
      userMessage: userBody,
      uploadedDocs: run.context.documentContext,
      imageNote: imageNote || undefined,
    })

    const userMsg: AiMessage = { role: 'user', content: enhancedMessage }
    if (hasImages && visionAvailable) {
      userMsg.images = run.context.images
    }
    return userMsg
  }
  
  /**
   * 加载知识库上下文
   */
  protected async loadKnowledgeContext(message: string, hostId?: string): Promise<KnowledgeContextResult> {
    let context = ''
    let enabled = false
    
    try {
      const knowledgeService = getKnowledgeService()
      if (knowledgeService && knowledgeService.isEnabled()) {
        enabled = true
        context = await knowledgeService.buildContext(message, { hostId })
      }
    } catch (e) {
      log.warn('Knowledge service error:', e)
    }
    
    return { context, enabled, conversationHistory: [] }
  }
  
  // ==================== 受保护方法：执行循环 ====================
  
  /**
   * 主执行循环
   */
  protected async executeLoop(run: AgentRun): Promise<string> {
    let stepCount = 0
    let lastResponse: ChatWithToolsResult | null = null
    let hasExecutedAnyTool = false
    let noToolCallRetryCount = 0
    let truncationRetryCount = 0
    const MAX_NO_TOOL_RETRIES = 2
    const MAX_TRUNCATION_RETRIES = 3
    
    // 创建工具执行器配置
    const toolExecutorConfig = this.createToolExecutorConfig(run)
    
    // 外层循环：支持从 catch 块恢复
    executionLoop: while (run.isRunning && !run.aborted) {
      try {
        // 内层循环：Agent 执行
        while ((run.config.maxSteps === 0 || stepCount < run.config.maxSteps) && run.isRunning && !run.aborted) {
          stepCount++
          
          // 处理待处理的用户消息
          this.processPendingUserMessages(run)
          
          // 执行单步
          const stepResult = await this.executeStep(run, toolExecutorConfig)
          
          if (stepResult.response) {
            lastResponse = stepResult.response
          }
          
          // 输出被截断时强制继续循环（已在 executeStep 中注入续写提示）
          if (stepResult.truncated) {
            truncationRetryCount++
            if (truncationRetryCount >= MAX_TRUNCATION_RETRIES) {
              log.warn('Output repeatedly truncated, giving up continuation')
              return lastResponse?.content || t('agent.no_response')
            }
            continue
          }
          
          if (stepResult.hasToolCalls) {
            hasExecutedAnyTool = true
            noToolCallRetryCount = 0
            truncationRetryCount = 0
            // 每完成一轮工具调用后保存检查点，防止程序意外退出丢失对话记录
            this.saveCheckpoint(run)
          }
          
          // 处理无工具调用的情况
          if (!stepResult.hasToolCalls) {
            if (!hasExecutedAnyTool) {
              // 从未执行过工具
              if (run.pendingUserMessages.length > 0) {
                continue
              }
              
              if (lastResponse?.content?.trim()) {
                // 直接返回，让 run() 方法中的 finalizeRun 处理完成回调
                return lastResponse.content
              }
              
              noToolCallRetryCount++
              if (noToolCallRetryCount >= MAX_NO_TOOL_RETRIES) {
                this.addStep({
                  type: 'error',
                  content: `⚠️ ${t('agent.no_content')}\n\n${t('agent.no_content_reasons')}`
                })
                return t('agent.no_response')
              }
              continue
            }
            
            // 已执行过工具，检查是否有待处理的消息
            if (run.pendingUserMessages.length > 0) {
              continue
            }
            
            // 检查计划进度
            const planAction = this.checkPlanProgress(run)
            if (planAction === 'continue') {
              continue
            }
            
            // 正常结束，直接返回结果
            const finalResult = lastResponse?.content || t('agent.task_complete')
            return finalResult
          }
        }
        
        // 循环正常结束
        break executionLoop
        
      } catch (error) {
        // 检查是否是用户消息中断
        const errorMsg = error instanceof Error ? error.message : String(error)
        const isAborted = errorMsg.toLowerCase().includes('aborted')
        
        if (isAborted && run.pendingUserMessages.length > 0) {
          log.info('AI 输出被用户消息中断，继续循环处理')
          // 修复不完整的 tool_calls 消息序列
          // 当 abort 发生在工具执行过程中时，可能存在 assistant 消息（含 tool_calls）但缺少对应的 tool result
          this.fixIncompleteToolCalls(run)
          continue executionLoop
        }
        
        throw error
      }
    }
    
    // 被中止
    if (run.aborted) {
      return t('error.operation_aborted')
    }
    
    return lastResponse?.content || t('agent.task_complete')
  }
  
  /**
   * 执行单步
   */
  protected async executeStep(
    run: AgentRun, 
    toolExecutorConfig: ToolExecutorConfig
  ): Promise<{ response: ChatWithToolsResult | null; hasToolCalls: boolean; truncated?: boolean }> {
    // 清理旧的工具输出，释放 token（taskMessageLog 不受影响）
    // 工具的可清理性由 _meta.contextBudget 声明，基类只是注入 lookup 回调
    applyToolResultBudget(run.messages, (name) => getMetaByName(this.getAvailableTools(), name))

    // 更新上下文状态（注入 Context Status + 渐进式提醒）
    this.updateContextPressure(run)
    
    // 记录流式执行前的步骤数，用于后续 ensureToolResultStep 正确检测预执行工具的步骤
    const stepCountBeforeStreaming = run.steps.length

    // 创建流式工具执行器：AI 流式输出过程中提前启动工具，并在每个工具完成的瞬间
    // 立即把 UI 卡片切到完成态（"完成一个显示一个"），不必等 AI 整段输出结束。
    const availableToolNames = new Set(this.getAvailableTools().map(t => t.function.name))
    const streamingExecutor = new StreamingToolExecutor({
      run,
      executeFn: (toolCall) => this.executeToolWithChecks(run, toolCall, toolExecutorConfig),
      availableToolNames,
      isConcurrencySafe: (name) => this.isParallelizableTool(name),
      onToolCompleted: ({ toolCall, result }) => {
        log.info(`[onToolCompleted] tool=${toolCall.function.name} id=${toolCall.id} success=${result.success}`)
        // 仅做 UI 层回填（兜底 tool_result + finalizeToolCallStep），消息历史
        // 仍保留按 toolCalls 原始顺序在 executeToolCallsWithStreaming 中统一写入。
        this.ensureToolResultStep(run, stepCountBeforeStreaming, toolCall, result)
        this.finalizeToolCallStep(run, toolCall.id, result.success)
      }
    })
    
    // 调用 AI（传入流式执行器，使其在流式输出中提前执行工具）
    const response = await this.callAiWithStreaming(run, streamingExecutor)

    // 缓存最近一次 assistant 响应的 reasoning_content
    // finalizeRun 的最终纯文本 assistant 消息会从这里取（思考模式必须回传）
    if (response.reasoning_content !== undefined) {
      run.lastAssistantReasoningContent = response.reasoning_content
    }

    // 处理 finish_reason=length（输出被 max_tokens 截断）
    if (response.finish_reason === 'length') {
      streamingExecutor.abort()
      
      const totalToolCalls = response.tool_calls?.length || 0
      const validToolCalls = (response.tool_calls || []).filter(tc => {
        if (!tc.id || !tc.function.name || !tc.function.arguments) return false
        try { JSON.parse(tc.function.arguments); return true }
        catch (e) { if (e instanceof SyntaxError) return false; throw e }
      })
      const discardedCount = totalToolCalls - validToolCalls.length
      
      if (discardedCount > 0) {
        log.warn(`Output truncated (finish_reason=length): discarded ${discardedCount}/${totalToolCalls} tool_calls with incomplete arguments`)
      } else if (totalToolCalls === 0) {
        log.warn(`Output truncated (finish_reason=length): text content may be incomplete`)
      }
      
      // 有有效的工具调用 → 正常执行，截断的已被丢弃
      if (validToolCalls.length > 0) {
        log.info(`Proceeding with ${validToolCalls.length} valid tool_calls despite truncation`)
        response.tool_calls = validToolCalls
      } else {
        const truncationHint: AiMessage = {
          role: 'assistant',
          content: response.content || ''
        }
        if (response.reasoning_content !== undefined) {
          truncationHint.reasoning_content = response.reasoning_content
        }
        run.messages.push(truncationHint)
        run.taskMessageLog.push({ ...truncationHint })
        
        const continuationPrompt: AiMessage = {
          role: 'user',
          content: t('agent.output_truncated_hint'),
          _systemInjected: true
        }
        run.messages.push(continuationPrompt)
        run.taskMessageLog.push({ ...continuationPrompt })
        
        this.addStep({
          type: 'thinking',
          content: `⚠️ ${t('agent.output_truncated')}`
        })
        
        return { response, hasToolCalls: false, truncated: true }
      }
    }
    
    // 处理工具调用
    if (response.tool_calls && response.tool_calls.length > 0) {
      const validToolCalls = response.tool_calls.filter(tc => {
        if (!tc.id || !tc.function.name || !tc.function.arguments) return false
        try { JSON.parse(tc.function.arguments); return true }
        catch (e) { if (e instanceof SyntaxError) return false; throw e }
      })
      
      if (validToolCalls.length < response.tool_calls.length) {
        log.warn(`Discarded ${response.tool_calls.length - validToolCalls.length} tool_calls with malformed arguments`)
      }
      
      if (validToolCalls.length === 0) {
        streamingExecutor.abort()
        const discardedNames = response.tool_calls.map(tc => tc.function?.name || 'unknown').join(', ')
        log.warn(`All tool_calls discarded due to malformed arguments: [${discardedNames}], triggering retry`)
        
        const assistantMsg: AiMessage = {
          role: 'assistant',
          content: response.content || ''
        }
        if (response.reasoning_content !== undefined) {
          assistantMsg.reasoning_content = response.reasoning_content
        }
        run.messages.push(assistantMsg)
        run.taskMessageLog.push({ ...assistantMsg })
        
        const retryHint: AiMessage = {
          role: 'user',
          content: t('agent.tool_args_malformed', { tools: discardedNames }),
          _systemInjected: true
        }
        run.messages.push(retryHint)
        run.taskMessageLog.push({ ...retryHint })
        
        this.addStep({
          type: 'thinking',
          content: `⚠️ ${t('agent.tool_args_malformed_step', { tools: discardedNames })}`
        })
        
        return { response, hasToolCalls: false, truncated: true }
      }
      
      // 移除初始步骤
      if (run.initialStepId) {
        this.removeStep(run.initialStepId)
        run.initialStepId = undefined
      }
      
      // 添加 assistant 消息到历史
      // DeepSeek V3.2+ 思考模式：带 tool_calls 的 assistant 消息后续请求必须回传 reasoning_content
      // 这里用 !== undefined 确保即使模型只返回空字符串也会被保留（避免 || 把空串转成 undefined）
      const assistantMsg: AiMessage = {
        role: 'assistant',
        content: response.content || '',
        tool_calls: validToolCalls
      }
      if (response.reasoning_content !== undefined) {
        assistantMsg.reasoning_content = response.reasoning_content
      }
      run.messages.push(assistantMsg)
      run.taskMessageLog.push({ ...assistantMsg })
      
      // 执行工具调用（流式执行器可能已完成部分工具）
      await this.executeToolCallsWithStreaming(run, validToolCalls, toolExecutorConfig, streamingExecutor, stepCountBeforeStreaming)
      
      return { response, hasToolCalls: true }
    }
    
    return { response, hasToolCalls: false }
  }
  
  // ==================== 受保护方法：AI 交互 ====================
  
  /**
   * 本次请求是否会在 API 消息体中带有多模态图片（与 AiService.formatMessageForApi 一致：仅 user 消息的 images）
   * 注意：不能只检查「最新一轮 user 是否带图」。历史 user 消息里的 images 仍会原样发给 API，
   * 若主模型不支持视觉却未切换到关联视觉模型，会报错（例如火山 deepseek「Model do not support image input」）。
   */
  private conversationContainsImages(messages: AiMessage[]): boolean {
    return messages.some(m => m.role === 'user' && m.images && m.images.length > 0)
  }

  /**
   * 当前 Agent 使用的 profile 是否具备视觉能力。
   * 用于在拼装消息阶段判断是否应该携带 base64 图片：
   * - 不具备能力时附带图片，部分网关会静默丢弃 image_url（既不报错也不处理），
   *   但 AI 仍会因 system 提示「图片已嵌入」而假装看到图片，进而瞎编内容。
   * - 因此无视觉能力时应主动剥图，并在文本里告知 AI「用户附了图但你看不到」，
   *   让模型如实告诉用户改用视觉模型。
   */
  private currentProfileHasVision(): boolean {
    const configService = this.services.configService
    if (!configService) return false
    return configService.hasVisionCapability(this.profileId)
  }
  
  /**
   * 解析本次 API 调用应使用的 profileId
   * 当满足以下条件时自动切换到视觉模型：
   * 1. autoVisionModel 全局开关已启用
   * 2. 当前主模型配置了 visionProfileId
   * 3. 整条 messages 中仍有带 images 的 user 消息（formatMessageForApi 会一并发出）
   */
  private resolveEffectiveProfileId(run: AgentRun): string | undefined {
    const configService = this.services.configService
    if (!configService) return this.profileId
    
    const autoVision = configService.get('autoVisionModel')
    if (!autoVision) return this.profileId
    
    if (!this.conversationContainsImages(run.messages)) return this.profileId
    
    // 获取当前主模型的 profile
    const profiles = configService.getAiProfiles()
    const currentProfileId = this.profileId || configService.getActiveAiProfile()
    const currentProfile = profiles.find(p => p.id === currentProfileId)
    
    if (!currentProfile) return this.profileId
    
    // 如果当前模型本身就是 vision 类型，无需切换
    if (currentProfile.modelType === 'vision') return this.profileId
    
    // 如果配置了关联视觉模型，切换过去（排除自引用和不存在的 profile）
    const visionId = currentProfile.visionProfileId
    if (visionId && visionId !== currentProfileId && profiles.some(p => p.id === visionId)) {
      const visionProfile = profiles.find(p => p.id === visionId)
      log.info(`Vision routing: switching from ${currentProfile.model} to ${visionProfile?.model || visionId}`)
      return visionId
    }
    
    return this.profileId
  }
  
  /**
   * 流式调用 AI
   * @param streamingExecutor 可选的流式工具执行器，传入时会在流式过程中提前启动工具执行
   */
  protected async callAiWithStreaming(run: AgentRun, streamingExecutor?: StreamingToolExecutor): Promise<ChatWithToolsResult> {
    // 用 let 而非 const：第一次 onChunk 时若 initial "正在准备..." step 还在，
    // 会把 streamStepId 复用为 initialStepId，让前端 list item identity 保持不变（详见 onChunk 分支）
    let streamStepId = this.generateId()
    let streamContent = ''
    let lastContentUpdate = 0
    let pendingUpdate = false
    let streamStepCreated = false
    // 最近一次重试提示步骤的 id（用 waiting 类型，让用户知道"自动重试中"，避免误以为卡住）
    // 重试成功（首次 onChunk 到达）/ 最终失败（onError）/ 完成（onDone 兜底）时停掉 streaming 状态
    let lastRetryStepId: string | undefined
    // 每个 toolCallId 独立节流（多个 tool_call 并行流式时互不干扰）
    const toolProgressThrottle = new Map<string, number>()
    const STREAM_THROTTLE_MS = 100
    const TOOL_PROGRESS_THROTTLE_MS = 120

    // 把当前"正在重试"卡片定稿（关闭 spinner），保留卡片作为审计痕迹。
    // 触发时机：重试成功（首次 onChunk）/ 整体完成（onDone）/ 最终失败（onError）/ 下一轮重试开始
    const finalizeRetryStep = () => {
      if (lastRetryStepId) {
        this.updateStep(lastRetryStepId, { isStreaming: false })
        lastRetryStepId = undefined
      }
    }
    
    const sendContentUpdate = () => {
      // reasoning 块一旦闭合（</details> 出现意味着 AI 已结束思考、切到 content 或 tool_calls 阶段），
      // 立刻把 <details open> 替换为 <details> 折叠思考卡。不这样做的话会等到整个流结束（onDone）
      // 才折叠，而 tool_calls 参数流式（尤其 write_text_file 的 content）动辄几秒到几十秒，
      // 用户会误以为"思考还在进行"。替换是幂等的，onDone 里的 replace 继续作为兜底。
      if (streamContent.includes('</details>') && streamContent.includes('<details open>')) {
        streamContent = streamContent.replace(/<details open>/g, '<details>')
      }
      this.updateStep(streamStepId, {
        type: 'message',
        content: streamContent,
        isStreaming: true
      })
      lastContentUpdate = Date.now()
      pendingUpdate = false
    }
    
    const availableTools = this.getAvailableTools()
    // 发给 LLM 之前剥离 _meta（内部元数据，发出去会浪费 token）
    const llmTools = stripToolMeta(availableTools)

    // Plugin hook: before_ai_request (must run before the Promise callback)
    const hookBus = this.services.pluginRegistry?.hookBus
    if (hookBus?.hasHandlers('before_ai_request')) {
      await hookBus.trigger('before_ai_request', {
        messages: run.messages as Array<{ role: string; content: string }>,
        tools: llmTools
      })
    }

    return new Promise<ChatWithToolsResult>((resolve, reject) => {
      streamContent = ''
      lastContentUpdate = 0
      pendingUpdate = false
      streamStepCreated = false
      toolProgressThrottle.clear()

      run.requestId = run.id
      
      const effectiveProfileId = this.resolveEffectiveProfileId(run)
      
      this.services.aiService.chatWithToolsStream(
        run.messages,
        llmTools,
        // onChunk
        (chunk) => {
          streamContent += chunk
          const now = Date.now()
          
          // 第一次收到内容：优先复用 initial "正在准备..." step 的 id 把它原地改造为 message
          // 流式态。这样前端只看到一次 updateStep（type/content 变化），list item identity 不变，
          // 不会经历"先 add new + 再 remove old"两步 reactive 更新带来的 unmount/mount 闪动。
          // 配合前端把 initial preparing 渲染成跟 message + ThinkingBlock 完全一致的视觉壳，
          // 用户感知到的就是文字"正在准备..." → "思考中 N.Ns"无缝切换，整体持续往下输出。
          if (!streamStepCreated) {
            streamStepCreated = true
            // 重试成功：把上一次的"正在重试..."提示定稿（保留卡片但停掉 spinner）
            finalizeRetryStep()
            if (run.initialStepId) {
              streamStepId = run.initialStepId
              this.updateStep(streamStepId, {
                type: 'message',
                content: streamContent,
                isStreaming: true
              })
              run.initialStepId = undefined
            } else {
              // initial step 不存在的边角场景（如未来某个分支提前清理过）：退化为 addStep
              this.addStep({
                id: streamStepId,
                type: 'message',
                content: streamContent,
                isStreaming: true
              })
            }
            lastContentUpdate = Date.now()
            return
          }
          
          if (now - lastContentUpdate >= STREAM_THROTTLE_MS) {
            sendContentUpdate()
          } else if (!pendingUpdate) {
            pendingUpdate = true
            setTimeout(() => {
              if (pendingUpdate) {
                sendContentUpdate()
              }
            }, STREAM_THROTTLE_MS)
          }
        },
        // onToolCall
        (_toolCalls) => {
          // 工具调用在 onDone 中处理
        },
        // onDone
        (result) => {
          pendingUpdate = false
          // 预创建的 tool_call 卡片保留、稍后由工具执行器接管（见 executeToolWithChecks 中的 addStep 拦截）
          // 此处只把仍处于 isStreaming 的预卡片停掉光标，避免"参数没来得及更新但模型已结束"的极端情况下卡片一直抖
          if (run.pendingPreToolCallStepIds) {
            for (const [, stepId] of run.pendingPreToolCallStepIds) {
              this.updateStep(stepId, { isStreaming: false })
            }
          }
          // 重试成功但服务端立即返回（无 content/tool_call 流）时，onChunk 不会触发，这里兜底关掉 spinner
          finalizeRetryStep()

          // 累积 token usage（由 LLM provider 返回的精确值）
          if (result.usage) {
            if (!run.tokenUsage) {
              run.tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            }
            run.tokenUsage.prompt_tokens += result.usage.prompt_tokens
            run.tokenUsage.completion_tokens += result.usage.completion_tokens
            run.tokenUsage.total_tokens += result.usage.total_tokens
            if (result.usage.cache_hit_tokens !== undefined) {
              run.tokenUsage.cache_hit_tokens = (run.tokenUsage.cache_hit_tokens || 0) + result.usage.cache_hit_tokens
            }
            if (result.usage.cache_miss_tokens !== undefined) {
              run.tokenUsage.cache_miss_tokens = (run.tokenUsage.cache_miss_tokens || 0) + result.usage.cache_miss_tokens
            }
            this._lastPromptTokens = result.usage.prompt_tokens
          }

          // 先定稿流式步骤
          let finalContent = streamContent.replace(/<details open>/g, '<details>')
          if (finalContent.includes('<details>') && !finalContent.includes('</details>')) {
            finalContent += '\n\n</blockquote>\n</details>'
          }
          // 去重：部分 API 代理可能导致连续出现内容相同的思考块，只保留第一个
          finalContent = deduplicateThinkingBlocks(finalContent)
          // message step 内容保持完整（思考块 + 正文），不再剥离正文给 final_result。
          // 前端只渲染 message step（含完整内容），失败/中断的 final_result 才以独立卡片呈现，
          // 成功的 final_result 不再渲染——这样流式 → 完成切换时只有 ThinkingBlock 从流式态
          // 切到完成态，正文位置和下方布局完全不变，达到"持续往下输出"的稳定感。
          if (finalContent && streamStepCreated) {
            this.updateStep(streamStepId, {
              type: 'message',
              content: finalContent,
              isStreaming: false
            })
          } else if (!streamStepCreated && finalContent) {
            this.addStep({
              id: streamStepId,
              type: 'message',
              content: finalContent,
              isStreaming: false
            })
            streamStepCreated = true
          }

          // 在步骤定稿后推送 contextTokens（避免设置到即将被删除的临时步骤上）
          if (result.usage) {
            const steps = this.currentRun?.steps
            if (steps && steps.length > 0) {
              // 优先选择已定稿的流式步骤，否则选最近的非临时步骤（跳过 initialStep）
              let targetStep = streamStepCreated
                ? steps.find(s => s.id === streamStepId)
                : undefined
              if (!targetStep) {
                for (let i = steps.length - 1; i >= 0; i--) {
                  if (steps[i].id !== run.initialStepId) { targetStep = steps[i]; break }
                }
              }
              if (targetStep) {
                targetStep.contextTokens = result.usage.prompt_tokens
                // 记录本次调用实际使用的模型信息（视觉路由切换时与 activeAiProfile 不同）
                const effectiveProfile = this.services.configService
                  ?.getAiProfiles()?.find(p => p.id === effectiveProfileId)
                if (effectiveProfile?.contextLength) {
                  targetStep.effectiveContextLength = effectiveProfile.contextLength
                }
                if (effectiveProfile?.name) {
                  targetStep.effectiveModel = effectiveProfile.name
                }
                const cacheTotal = (result.usage.cache_hit_tokens || 0) + (result.usage.cache_miss_tokens || 0)
                if (cacheTotal > 0 && result.usage.prompt_tokens > 0) {
                  targetStep.cacheHitRate = Math.round((result.usage.cache_hit_tokens || 0) / result.usage.prompt_tokens * 100)
                  this._lastCacheHitRate = targetStep.cacheHitRate
                } else {
                  this._lastCacheHitRate = undefined
                }
                this.callbacks?.onStep?.(this.currentRun?.id || '', targetStep)
              }
            }
          }
          resolve(result)
        },
        // onError
        (error) => {
          // 出错时把预创建的 tool_call 卡片移除，避免留下没有结果的空卡
          this.discardPreToolCallSteps(run)
          // 重试最终失败时也要把 spinner 关掉，否则"正在重试"卡片会一直转
          finalizeRetryStep()
          // 清理残留的流式步骤：最后一次重试若已收到部分 chunk，stream step 的
          // isStreaming 还是 true，计时器会一直跑；移除它，避免"思考中 XXXs"僵在屏幕上
          if (streamStepCreated) {
            this.removeStep(streamStepId)
            streamStepCreated = false
          }
          // 清理初始"正在准备..."占位步骤：首次请求就失败（无重试）或 onRetry 里
          // retryInfo 为空（vision-fallback 等内部重试）时，initialStepId 不会在
          // onRetry 中被清理，需要在这里兜底清理，否则计时器会一直跑
          if (run.initialStepId) {
            this.removeStep(run.initialStepId)
            run.initialStepId = undefined
          }
          reject(new Error(error))
        },
        effectiveProfileId, // 视觉路由：有新图片时自动切换到视觉模型
        // onToolCallProgress - 流式生成 tool_call 参数时以"最终形态的"内容预创建一张
        // tool_call 卡片；随后该卡片会被工具执行器"认领"并 updateStep 成正式内容，
        // 因为格式一致（同前缀、同字体、同样式），视觉上就是同一张卡上的文本在逐字增长。
        //
        // 工具执行透明原则（见 SPEC.md「工具执行透明原则」）：所有工具执行器都会无条件
        // emit `tool_call` 卡片再执行，确保用户看到「Agent 准备做什么 → 在做 → 做完」。
        // 预创建（本回调）是这一原则在流式输出场景下的进一步强化：把卡片的出现时机从
        // 「执行开始」提前到「参数还在流」的阶段，避免「AI 在思考但屏幕一片空白」的体感。
        //
        // 默认所有工具都生成预卡片：声明了 _meta.streamDisplay 的工具走富信息渲染，
        // 没声明的工具走通用兜底「调用: {toolName}」。基类不知道具体工具叫什么——
        // 展示行为完全由各自 ToolDefinition 自己声明。
        (toolCallId: string, toolName: string, partialArgs: string) => {
          if (!toolCallId) return  // 没有稳定 id 就无法与后续 executor 的 addStep 关联，跳过

          const now = Date.now()
          const lastAt = toolProgressThrottle.get(toolCallId) || 0
          if (now - lastAt < TOOL_PROGRESS_THROTTLE_MS) return

          const meta = getMetaByName(this.getAvailableTools(), toolName)
          const built = buildPreToolCallDisplay(toolName, partialArgs, meta)
          // 解析失败时不回退显示（保留上一次已解析内容），让用户观感上是"连续增长"
          if (!run.pendingPreToolCallText) run.pendingPreToolCallText = new Map()
          const previousText = run.pendingPreToolCallText.get(toolCallId)
          const displayContent = built ?? previousText
          if (displayContent === undefined) return  // 还没可显示内容
          if (built !== null) run.pendingPreToolCallText.set(toolCallId, built)
          toolProgressThrottle.set(toolCallId, now)

          if (!run.pendingPreToolCallStepIds) run.pendingPreToolCallStepIds = new Map()
          let stepId = run.pendingPreToolCallStepIds.get(toolCallId)
          if (!stepId) {
            stepId = this.generateId()
            run.pendingPreToolCallStepIds.set(toolCallId, stepId)
            // 先创建 tool_call 卡片再移除初始步骤，避免前端 steps 出现瞬时为 0 的中间态
            this.addStep({
              id: stepId,
              type: 'tool_call',
              content: displayContent,
              toolName,
              toolCallId,
              isStreaming: true
            })
            if (run.initialStepId) {
              this.removeStep(run.initialStepId)
              run.initialStepId = undefined
            }
          } else {
            this.updateStep(stepId, {
              type: 'tool_call',
              content: displayContent,
              toolName,
              isStreaming: true
            })
          }
        },
        run.id, // requestId
        // onRetry - 重试时重置流状态，避免 reasoning 块重复
        // retryInfo 由 ai.service 提供，用来在 UI 上显示"正在重试"，避免用户以为应用卡死
        (retryInfo?: RetryInfo) => {
          log.info(`AI request retrying (reason=${retryInfo?.reason ?? 'unknown'}), resetting stream state`)
          streamContent = ''
          pendingUpdate = false
          lastContentUpdate = 0
          toolProgressThrottle.clear()
          if (streamStepCreated) {
            this.removeStep(streamStepId)
            streamStepCreated = false
            // streamStepId 可能复用过 initialStepId，这里重新生成避免下次 addStep 撞 id
            streamStepId = this.generateId()
          }
          this.discardPreToolCallSteps(run)
          // 重试时中止已启动的流式工具执行
          streamingExecutor?.abort()
          // 把上一次的"正在重试"卡片定稿（这次新的重试会再起一张），避免多张同时转 spinner
          finalizeRetryStep()
          // 显示 waiting 卡片让用户清楚"在等下次重试"，而不是"卡住了"。
          // retryInfo 缺失时（如 vision-fallback 等内部重试）不显示，避免误导用户
          if (retryInfo) {
            const seconds = String(Math.max(1, Math.round(retryInfo.delayMs / 1000)))
            const params: Record<string, string> = {
              attempt: String(retryInfo.attempt),
              max: String(retryInfo.max),
              seconds
            }
            if (retryInfo.statusCode !== undefined) params.status = String(retryInfo.statusCode)
            const i18nKey =
              retryInfo.reason === 'rate_limit' ? 'agent.retry_rate_limit' :
              retryInfo.reason === 'server_error' ? 'agent.retry_server_error' :
              'agent.retry_network'
            const stepId = this.generateId()
            lastRetryStepId = stepId
            this.addStep({
              id: stepId,
              type: 'waiting',
              content: `🔄 ${t(i18nKey, params)}`,
              isStreaming: true
            })
            // waiting 卡已经"接班"显示状态，再移除初始"正在准备..."步骤
            // 顺序：先 add 再 remove，避免前端 steps 瞬时为 0 的中间态
            if (run.initialStepId) {
              this.removeStep(run.initialStepId)
              run.initialStepId = undefined
            }
          } else {
            // retryInfo 缺失（vision-fallback 等）：不展示 waiting 卡，但仍需清理
            // 初始占位步骤，否则"正在准备..."会在无 waiting 接班时孤立显示
            if (run.initialStepId) {
              this.removeStep(run.initialStepId)
              run.initialStepId = undefined
            }
          }
        },
        // onToolCallReady - 流式中 tool_call 参数完整时立即投入执行
        streamingExecutor
          ? (toolCall) => {
              log.info(`Streaming tool ready: ${toolCall.function.name} (id=${toolCall.id})`)
              streamingExecutor.addTool(toolCall)
            }
          : undefined
      )
    })
  }
  
  // ==================== 受保护方法：工具执行 ====================

  /**
   * 判断工具是否可以并行执行（只读 / 无副作用 / 跨工具无相互依赖）
   *
   * 默认 false（串行）；工具可以在 ToolDefinition._meta.parallelizable 里声明覆盖。
   * 基类不知道具体工具叫什么。
   */
  private isParallelizableTool(toolName: string): boolean {
    const meta = getMetaByName(this.getAvailableTools(), toolName)
    return meta?.parallelizable === true
  }
  
  /**
   * 执行工具调用列表（支持并行执行相邻的只读工具）
   * 
   * 执行策略：保持原始顺序，只对相邻的可并行工具进行并行优化
   * 例如：[read_file, read_file, execute_command, read_file, read_file]
   * 会分成3批执行：
   *   1. read_file || read_file （并行）
   *   2. execute_command        （顺序）
   *   3. read_file || read_file （并行）
   */
  protected async executeToolCalls(
    run: AgentRun, 
    toolCalls: ToolCall[],
    toolExecutorConfig: ToolExecutorConfig
  ): Promise<void> {
    if (toolCalls.length === 0) return

    // 防御模型幻觉：校验工具调用是否在当前可用列表中
    const availableToolNames = new Set(this.getAvailableTools().map(t => t.function.name))
    const validToolCalls: ToolCall[] = []
    for (const toolCall of toolCalls) {
      if (availableToolNames.has(toolCall.function.name)) {
        validToolCalls.push(toolCall)
        continue
      }
      log.warn(`Rejected hallucinated tool call: ${toolCall.function.name}`)
      const error = t('error.unknown_tool', { name: toolCall.function.name })
      this.addStep({
        type: 'tool_result',
        content: `⚠️ ${error}`,
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        toolResult: error,
        success: false
      })
      this.processToolResult(run, toolCall, { success: false, output: '', error }, {})
    }

    if (validToolCalls.length === 0) {
      run.executionPhase = 'thinking'
      run.currentToolName = undefined
      return
    }
    
    // 将工具调用分成多个批次，相邻的可并行工具放在同一批次
    const batches: { parallel: boolean; tools: ToolCall[] }[] = []
    
    for (const toolCall of validToolCalls) {
      const isParallel = this.isParallelizableTool(toolCall.function.name)
      const lastBatch = batches[batches.length - 1]
      
      if (lastBatch && lastBatch.parallel === isParallel) {
        // 与上一批次类型相同，加入同一批次
        lastBatch.tools.push(toolCall)
      } else {
        // 开始新批次
        batches.push({ parallel: isParallel, tools: [toolCall] })
      }
    }
    
    try {
      for (const batch of batches) {
        if (run.aborted) break

        if (batch.parallel && batch.tools.length > 1) {
          await this.executeToolBatchParallel(run, batch.tools, toolExecutorConfig)
        } else {
          for (const toolCall of batch.tools) {
            if (run.aborted) break
            await this.executeToolSingle(run, toolCall, toolExecutorConfig)
          }
        }
      }
    } finally {
      // 当前 assistant.tool_calls 这批工具的 tool 消息已全部写入 run.messages，
      // 此时把工具返回的图片合并为一条 user 消息追加到末尾（见 flushPendingToolImages）。
      // 用 try/finally 保证即便中途抛异常也不会留下未 flush 的图片污染下一批次。
      this.flushPendingToolImages(run)
      run.executionPhase = 'thinking'
      run.currentToolName = undefined
    }
  }
  
  /**
   * 带流式预执行的工具调用处理。
   *
   * StreamingToolExecutor 在 AI 流式输出过程中已提前启动部分工具。
   * 本方法：
   * 1. 等待流式执行器完成所有已投入的工具
   * 2. 收集预执行的结果并 processToolResult
   * 3. 对剩余未预执行的工具走传统 executeToolCalls 路径
   */
  private async executeToolCallsWithStreaming(
    run: AgentRun,
    toolCalls: ToolCall[],
    toolExecutorConfig: ToolExecutorConfig,
    streamingExecutor: StreamingToolExecutor,
    stepCountBeforeStreaming: number
  ): Promise<void> {
    if (toolCalls.length === 0) return

    try {
      // 等待流式执行器中所有已投入的工具完成
      // UI 层回填（ensureToolResultStep / finalizeToolCallStep）已经在 onToolCompleted
      // 中"完成即处理"，这里只负责按原始 toolCalls 顺序把消息历史串起来。
      const preExecuted = await streamingExecutor.waitForAll()
      const preExecutedIds = new Set(preExecuted.map(r => r.toolCall.id))

      if (preExecuted.length > 0) {
        const names = preExecuted.map(r => r.toolCall.function.name).join(', ')
        log.info(`Streaming pre-executed ${preExecuted.length} tools: [${names}]`)
      }

      for (const toolCall of toolCalls) {
        if (!preExecutedIds.has(toolCall.id)) continue
        const completed = preExecuted.find(r => r.toolCall.id === toolCall.id)!
        // 兜底再调一次：若 onToolCompleted 出错或被跳过，这里仍能保证 UI 状态收尾
        this.ensureToolResultStep(run, stepCountBeforeStreaming, toolCall, completed.result)
        this.processToolResult(run, toolCall, completed.result, completed.toolArgs)
        this.finalizeToolCallStep(run, toolCall.id, completed.result.success)
      }

      // 过滤出未被流式执行器处理的工具
      const remaining = toolCalls.filter(tc => !preExecutedIds.has(tc.id))

      if (remaining.length > 0) {
        log.info(`Running ${remaining.length} remaining tools via standard path`)
        // executeToolCalls 内部会统一 flushPendingToolImages，
        // 把流式预执行批次和剩余批次累积的图片一次性合并为一条 user 消息。
        await this.executeToolCalls(run, remaining, toolExecutorConfig)
        // executeToolCalls 内的 finally 已经 flush 过了，下面的 finally 再调一次也是 no-op。
      }
    } finally {
      // 兜底 flush：streaming 全部预执行（无 remaining）路径不会经过 executeToolCalls；
      // 异常路径也不能留下未 flush 的图片污染下一批次。
      this.flushPendingToolImages(run)
      run.executionPhase = 'thinking'
      run.currentToolName = undefined
    }
  }
  
  /**
   * 并行执行一批工具
   *
   * "完成一个显示一个"：每个工具完成的瞬间立即在 UI 层兜底 tool_result 卡 +
   * 收尾 tool_call 卡的状态（success / isStreaming），不必等整批 Promise.all 结束。
   * 消息历史（run.messages）仍按 toolCalls 原始顺序在 await 之后统一 push，
   * 以稳定 OpenAI/Anthropic 协议中 tool 消息序列。
   */
  private async executeToolBatchParallel(
    run: AgentRun,
    toolCalls: ToolCall[],
    toolExecutorConfig: ToolExecutorConfig
  ): Promise<void> {
    const toolNames = toolCalls.map(tc => tc.function.name).join(', ')
    log.info(`Tools parallel batch: [${toolNames}]`)

    run.executionPhase = 'reading'
    run.currentToolName = `${toolCalls.length} tools`

    const batchStartTime = Date.now()
    const stepCountBefore = run.steps.length
    const parallelPromises = toolCalls.map(async (toolCall) => {
      if (run.aborted) {
        const aborted = {
          result: { success: false, output: '', error: t('error.operation_aborted') } as ToolResult,
          toolArgs: {} as Record<string, unknown>
        }
        // 中止状态也立刻收尾 UI 卡，避免占位卡停留在"运行中"
        this.ensureToolResultStep(run, stepCountBefore, toolCall, aborted.result)
        this.finalizeToolCallStep(run, toolCall.id, aborted.result.success)
        return { toolCall, ...aborted }
      }
      const out = await this.executeToolWithChecks(run, toolCall, toolExecutorConfig)
      // 完成即回填 UI（视觉层面"完成一个显示一个"）
      this.ensureToolResultStep(run, stepCountBefore, toolCall, out.result)
      this.finalizeToolCallStep(run, toolCall.id, out.result.success)
      return { toolCall, ...out }
    })

    const results = await Promise.all(parallelPromises)

    const batchElapsed = Date.now() - batchStartTime
    const successCount = results.filter(r => r.result.success).length
    log.info(`Tools parallel done: ${successCount}/${results.length} succeeded, ${batchElapsed}ms`)

    // 按原始顺序写入消息历史（协议层面）
    for (const { toolCall, result, toolArgs } of results) {
      this.processToolResult(run, toolCall, result, toolArgs)
    }
  }
  
  /**
   * 顺序执行单个工具
   */
  /**
   * 执行单个工具（含安全检查），返回结果但不写入消息历史。
   * 这是工具执行的核心路径，流式预执行和标准路径共用。
   */
  private async executeToolWithChecks(
    run: AgentRun,
    toolCall: ToolCall,
    toolExecutorConfig: ToolExecutorConfig
  ): Promise<{ result: ToolResult; toolArgs: Record<string, unknown> }> {
    let toolArgs: Record<string, unknown> = {}
    try {
      toolArgs = JSON.parse(toolCall.function.arguments)
    } catch {
      // 忽略解析错误
    }
    
    const toolName = toolCall.function.name
    const toolStartTime = Date.now()
    let result: ToolResult

    // Plugin hook: before_tool_call
    const hookBus = this.services.pluginRegistry?.hookBus
    if (hookBus?.hasHandlers('before_tool_call')) {
      const decision = await hookBus.trigger('before_tool_call', {
        toolName, toolArgs, toolCallId: toolCall.id
      })
      if (decision.block) {
        return { result: { success: false, output: '', error: 'Blocked by plugin' }, toolArgs }
      }
      if (decision.requireApproval) {
        const approved = await toolExecutorConfig.waitForConfirmation(
          toolCall.id, toolName, toolArgs, 'moderate'
        )
        if (!approved) {
          return { result: { success: false, output: '', error: t('error.operation_aborted') }, toolArgs }
        }
      }
    }

    // 把流式阶段预创建的 tool_call 卡片交给工具执行器：当执行器第一次 addStep 一张
    // tool_call 卡时，改为原地 updateStep 原卡，实现"生成→执行→结果"同一张卡的状态迁移。
    const wrappedConfig: ToolExecutorConfig = this.wrapExecutorConfigForToolCall(
      run, toolCall, toolExecutorConfig
    )

    try {
      result = await executeTool(
        run.ptyId,
        toolCall,
        run.config,
        run.context.terminalOutput,
        wrappedConfig
      )
    } catch (error) {
      result = { 
        success: false, 
        output: '', 
        error: error instanceof Error ? error.message : String(error) 
      }
    }

    const toolElapsed = Date.now() - toolStartTime
    if (result.success) {
      log.info(`Tool executed: ${toolName}, ${toolElapsed}ms, outputLen=${result.output.length}`)
    } else {
      log.warn(`Tool failed: ${toolName}, ${toolElapsed}ms, error=${(result.error || '').slice(0, 200)}`)
    }

    // Plugin hook: after_tool_call
    if (hookBus?.hasHandlers('after_tool_call')) {
      await hookBus.trigger('after_tool_call', {
        toolName, toolArgs, result: { success: result.success, output: result.output, error: result.error }
      })
    }

    return { result, toolArgs }
  }

  /**
   * 为单次工具执行包装 ToolExecutorConfig：
   * - 如果 run 中有本 toolCallId 对应的预创建 tool_call 卡片，首次收到 executor.addStep(type='tool_call')
   *   时改为 updateStep 原卡（把流式命令文本替换为执行器给出的正式内容，并收起光标），
   *   并返回原卡实例；第二次及之后的 tool_call addStep 正常新增。
   * - 其他 step 类型（tool_result / thinking 等）不受影响。
   *
   * 副作用：把 tool_call 步骤 ID 登记到 run.activeToolCallStepIds，
   * 供工具执行结束后 finalizeToolCallStep 反向回填 success（用于 UI 侧的"执行结果色竖条"）。
   */
  private wrapExecutorConfigForToolCall(
    run: AgentRun,
    toolCall: ToolCall,
    base: ToolExecutorConfig
  ): ToolExecutorConfig {
    const preStepId = run.pendingPreToolCallStepIds?.get(toolCall.id)
    const registerActive = (stepId: string) => {
      if (!run.activeToolCallStepIds) run.activeToolCallStepIds = new Map()
      run.activeToolCallStepIds.set(toolCall.id, stepId)
    }
    // 有预创建卡片时先登记：即使 executor 没有再 addStep(tool_call)（例如某些 skill 直接出结果），
    // finalizeToolCallStep 也能找到并收尾。
    if (preStepId) registerActive(preStepId)

    // 给所有 tool_call / tool_result 类型的步骤打上 toolCallId 戳，保证后续按 id 配对的可靠性。
    // 工具实现层不需要感知这个字段，由本层统一注入。
    const stamp = (step: Omit<AgentStep, 'id' | 'timestamp'>): Omit<AgentStep, 'id' | 'timestamp'> => {
      if (step.type === 'tool_call' || step.type === 'tool_result') {
        return { ...step, toolCallId: step.toolCallId ?? toolCall.id }
      }
      return step
    }

    let adopted = false
    return {
      ...base,
      addStep: (step) => {
        const stamped = stamp(step)
        if (!adopted && stamped.type === 'tool_call') {
          adopted = true
          if (preStepId) {
            base.updateStep(preStepId, { ...stamped, isStreaming: false })
            run.pendingPreToolCallStepIds?.delete(toolCall.id)
            run.pendingPreToolCallText?.delete(toolCall.id)
            const existing = run.steps.find(s => s.id === preStepId)
            if (existing) return existing
          }
          const created = base.addStep(stamped)
          registerActive(created.id)
          return created
        }
        return base.addStep(stamped)
      }
    }
  }

  /**
   * 丢弃 run 中所有尚未被执行器认领的预创建 tool_call 卡片（用于出错/重试场景）。
   * 这些卡片只承载了"生成中"的中间状态，没有正式的工具执行结果，所以直接移除是安全的。
   */
  private discardPreToolCallSteps(run: AgentRun): void {
    if (!run.pendingPreToolCallStepIds) return
    for (const [, stepId] of run.pendingPreToolCallStepIds) {
      this.removeStep(stepId)
    }
    run.pendingPreToolCallStepIds.clear()
    run.pendingPreToolCallText?.clear()
  }

  /**
   * 工具执行结束后的统一收尾：
   * - 关闭 tool_call 卡片的 isStreaming 光标
   * - 把 ToolResult.success 回填到卡片，让前端可以按"执行结果"给左竖条着色
   *   （失败=红、成功=不抢戏），和"风险等级"的视觉完全解耦
   * - 清理 pending / active 两份映射
   *
   * 兼容两种路径：
   *   A. 有预创建卡片（流式路径）：pendingPreToolCallStepIds 有 entry
   *   B. 无预创建卡片（非流式路径）：executor.addStep(tool_call) 后 activeToolCallStepIds 有 entry
   */
  private finalizeToolCallStep(run: AgentRun, toolCallId: string, success: boolean): void {
    const pendingStepId = run.pendingPreToolCallStepIds?.get(toolCallId)
    if (pendingStepId) {
      run.pendingPreToolCallStepIds!.delete(toolCallId)
      run.pendingPreToolCallText?.delete(toolCallId)
    }
    const activeStepId = run.activeToolCallStepIds?.get(toolCallId)
    const stepId = activeStepId ?? pendingStepId
    run.activeToolCallStepIds?.delete(toolCallId)
    if (!stepId) {
      log.warn(`[finalizeToolCallStep] no stepId for toolCallId=${toolCallId} (success=${success}, active=${activeStepId}, pending=${pendingStepId})`)
      return
    }
    log.info(`[finalizeToolCallStep] toolCallId=${toolCallId} stepId=${stepId} success=${success}`)
    this.updateStep(stepId, { isStreaming: false, success })
  }

  /**
   * 执行单个工具并写入消息历史（标准路径入口）。
   */
  private async executeToolSingle(
    run: AgentRun,
    toolCall: ToolCall,
    toolExecutorConfig: ToolExecutorConfig
  ): Promise<void> {
    const toolName = toolCall.function.name
    this.setExecutionPhase(run, toolName)
    const stepCountBefore = run.steps.length

    const { result, toolArgs } = await this.executeToolWithChecks(run, toolCall, toolExecutorConfig)

    this.ensureToolResultStep(run, stepCountBefore, toolCall, result)
    this.processToolResult(run, toolCall, result, toolArgs)
    this.finalizeToolCallStep(run, toolCall.id, result.success)
  }
  
  /**
   * 处理工具执行结果
   */
  private processToolResult(
    run: AgentRun,
    toolCall: ToolCall,
    result: ToolResult,
    _toolArgs: Record<string, unknown>
  ): void {
    const errorText = !result.success
      ? t('agent.tool_error', { error: result.error || t('agent.unknown_error') })
      : ''
    const resultContent = result.success
      ? result.output
      : result.output
        ? `${result.output}\n\n${errorText}`
        : errorText
    
    // AI Debug: 记录工具执行结果
    if (run.requestId) {
      getAiDebugService().logToolResult(run.requestId, {
        toolCallId: toolCall.id,
        success: result.success,
        result: resultContent
      })
    }
    
    // 添加工具结果到消息历史
    const toolMsg: AiMessage = {
      role: 'tool',
      content: resultContent,
      tool_call_id: toolCall.id
    }
    run.messages.push(toolMsg)
    run.taskMessageLog.push({ ...toolMsg })

    // 工具返回的图片不能立即 push 为 user 消息，否则会插在同批 tool 消息之间，
    // 破坏 OpenAI/DeepSeek 的 tool_calls 序列校验。先暂存，由 flushPendingToolImages
    // 在当前批次所有 tool 消息写完后统一注入（详见 AgentRun.pendingToolImages 注释）。
    if (result.images && result.images.length > 0) {
      if (!run.pendingToolImages) run.pendingToolImages = []
      run.pendingToolImages.push(...result.images)
    }
  }

  /**
   * 把当前批次累积的工具返回图片合并为单条 user 消息追加到 messages 末尾。
   *
   * 必须在一批 tool_calls 对应的所有 tool 消息都已写入 run.messages 之后调用，
   * 不能在每个工具完成后立即调用——否则 user 消息会夹在同批 tool 消息之间，
   * 触发 DeepSeek "insufficient tool messages following tool_calls message" 错误。
   *
   * 当前 profile 不具备视觉能力时，剥图但仍注入一条文本提示，让 AI 主动告知用户
   * （否则部分网关静默丢弃 image_url，AI 拿到「图片已嵌入」的提示却什么都看不到，
   * 容易凭文件名/上下文瞎编内容）。
   *
   * 设计成幂等：pendingToolImages 为空时直接返回，所以可以在多个边界点重复调用。
   */
  protected flushPendingToolImages(run: AgentRun): void {
    const pending = run.pendingToolImages
    if (!pending || pending.length === 0) return

    const imageCount = pending.length
    const visionAvailable = this.currentProfileHasVision()
    let imageMsg: AiMessage
    if (visionAvailable) {
      imageMsg = {
        role: 'user',
        content: t('agent.image_from_tool'),
        images: [...pending],
        // 标记为系统注入，避免 splitMessagesIntoTasks 把它当作 task 边界——
        // 否则会把同一个 task 切成两段，第二段开头是 tool 消息（孤儿 tool），
        // 下次启动时会触发 DeepSeek "tool must be a response to tool_calls" 错误。
        _systemInjected: true
      }
    } else {
      log.warn(`Dropping ${imageCount} tool-returned image(s) due to no vision capability on current profile`)
      imageMsg = {
        role: 'user',
        content: t('agent.tool_image_no_vision', { count: imageCount }),
        _systemInjected: true
      }
    }
    run.messages.push(imageMsg)
    // taskMessageLog 不保存 images（base64 太大，会撑爆持久化存储）
    run.taskMessageLog.push({ role: 'user', content: imageMsg.content, _systemInjected: true })

    run.pendingToolImages = []
  }
  
  /**
   * 确保工具执行后有 tool_result 步骤（内置工具自己添加，技能工具可能缺失）
   *
   * 优先按 toolCallId 配对，找不到时退化按 toolName 匹配（兼容老历史/未注入 id 的工具）。
   * 适用于顺序、并行、流式预执行等各种路径，同名同批多次调用时也能精准对齐每一份结果。
   *
   * 同时回填 `success` 字段到工具自己 emit 的 tool_result 卡上——前端依据
   * `step.success === false` 决定是否在非调试模式下也展开详情区，让用户看到错误。
   */
  private ensureToolResultStep(
    run: AgentRun,
    stepCountBefore: number,
    toolCall: ToolCall,
    result: ToolResult
  ): void {
    const toolCallId = toolCall.id
    const toolName = toolCall.function.name
    const newSteps = run.steps.slice(stepCountBefore)

    const matches = (s: AgentStep) => {
      if (s.toolCallId) return s.toolCallId === toolCallId
      // 老步骤未带 toolCallId：退化按 toolName 匹配（仅对没有任何 toolCallId 的卡兜底）
      return s.toolName === toolName
    }

    // 回填 success 到工具自己 emit 的 tool_result 卡（按 toolCallId 精准对齐）
    for (const s of newSteps) {
      if (s.type === 'tool_result' && s.success === undefined && matches(s)) {
        this.updateStep(s.id, { success: result.success })
      }
    }

    // 已存在本工具的结果卡（或有 error 步骤）就不再补 result 步骤
    if (newSteps.some(s => s.type === 'error' || (s.type === 'tool_result' && matches(s)))) return

    if (!result.success) {
      const errorMsg = result.error || t('agent.unknown_error')
      this.addStep({
        type: 'tool_result',
        content: `❌ ${toolName}`,
        toolName,
        toolCallId,
        toolResult: errorMsg,
        success: false
      })
    } else if (result.output) {
      const preview = result.output.length > 200
        ? result.output.slice(0, 200) + '…'
        : result.output
      this.addStep({
        type: 'tool_result',
        content: `✅ ${toolName}`,
        toolName,
        toolCallId,
        toolResult: preview,
        success: true
      })
    }
  }

  /**
   * 创建工具执行器配置
   */
  protected createToolExecutorConfig(run: AgentRun): ToolExecutorConfig {
    return {
      agentId: this._agentId || run.ptyId || undefined,
      terminalService: this.services.unifiedTerminalService || this.services.ptyService as any,
      hostProfileService: this.services.hostProfileService,
      mcpService: this.services.mcpService,
      skillSession: run.skillSession,
      pluginRegistry: this.services.pluginRegistry,
      addStep: (step) => this.addStep(step),
      updateStep: (stepId, updates) => this.updateStep(stepId, updates),
      waitForConfirmation: async (toolCallId, toolName, toolArgs, riskLevel, displayName) => {
        // 检查"始终允许"白名单（Agent 实例级别，跨 Run 持久化）
        const allowKey = this.generateAllowedToolKey(toolName, toolArgs)
        if (this.allowedTools.has(allowKey)) {
          return true
        }
        const result = await this.waitForConfirmation(run, toolCallId, toolName, toolArgs, riskLevel, displayName)
        return result.approved
      },
      requestSecureInput: async (skillId, envName, prompt, isUpdate) => {
        return this.requestSecureInput(run, skillId, envName, prompt, isUpdate)
      },
      isAborted: () => run.aborted,
      getHostId: () => run.context.hostId,
      hasPendingUserMessage: () => run.pendingUserMessages.length > 0,
      peekPendingUserMessage: () => run.pendingUserMessages[0]?.message,
      consumePendingUserMessage: () => run.pendingUserMessages.shift()?.message,
      getRealtimeTerminalOutput: () => [...run.realtimeOutputBuffer],
      getCurrentPlan: () => this.currentPlan,
      setCurrentPlan: (plan) => {
        this.currentPlan = plan
      },
      getTaskMemory: () => this.taskMemory,
      getSftpService: () => this.services.sftpService,
      getSshConfig: (terminalId) => this.services.sshService?.getConfig(terminalId) || null,
      // 上下文管理
      compressCurrentContext: (summary: string, keepRecent: number) => {
        return this.compressCurrentContext(run, summary, keepRecent)
      },
      getCompressedArchives: () => {
        return (run.compressedArchives || []).map(a => ({
          id: a.id,
          summary: a.summary,
          messageCount: a.messages.length,
          timestamp: a.timestamp
        }))
      },
      getCompressedArchive: (archiveId: string) => {
        const archive = run.compressedArchives?.find(a => a.id === archiveId)
        return archive ? archive.messages : null
      },
      historyService: this.services.historyService,
      getAiService: () => this.services.aiService,
      getActiveProfileId: () => this.profileId || this.services.configService?.getActiveAiProfile() || undefined,
      getAgentContext: () => run.context,
      getAiRules: () => this.services.configService?.getAiRules() ?? '',
      setCurrentPtyId: (ptyId: string) => {
        if (!ptyId || ptyId === run.ptyId) return
        const before = run.ptyId
        run.ptyId = ptyId
        run.context.ptyId = ptyId
        log.info(`Agent currentPtyId switched: ${before} → ${ptyId}`)
      },
      getCurrentPtyId: () => run.ptyId
    }
  }
  
  // ==================== 受保护方法：辅助功能 ====================
  
  /**
   * 添加执行步骤
   */
  protected addStep(step: Partial<AgentStep>): AgentStep {
    const fullStep: AgentStep = {
      id: step.id || this.generateId(),
      type: step.type || 'thinking',
      content: step.content || '',
      timestamp: Date.now(),
      ...step
    }
    
    this.currentRun?.steps.push(fullStep)
    this.callbacks?.onStep?.(this.currentRun?.id || '', fullStep)
    
    return fullStep
  }
  
  /**
   * 更新执行步骤（如果不存在则创建）
   */
  protected updateStep(stepId: string, updates: Partial<AgentStep>): void {
    if (!this.currentRun) return
    
    let step = this.currentRun.steps.find(s => s.id === stepId)
    
    if (!step) {
      // 如果步骤不存在，创建一个新的
      step = {
        id: stepId,
        type: updates.type || 'message',
        content: updates.content || '',
        timestamp: Date.now(),
        isStreaming: updates.isStreaming
      }
      this.currentRun.steps.push(step)
    } else {
      // 更新现有步骤
      Object.assign(step, updates)
    }
    
    this.callbacks?.onStep?.(this.currentRun.id, step)
  }
  
  /**
   * 移除执行步骤
   */
  protected removeStep(stepId: string): void {
    if (!this.currentRun) return

    const index = this.currentRun.steps.findIndex(s => s.id === stepId)
    if (index === -1) return

    this.currentRun.steps.splice(index, 1)
    this.callbacks?.onStepRemoved?.(this.currentRun.id, stepId)
  }
  
  /**
   * 处理待处理的用户消息（运行中追加的 addUserMessage）
   */
  protected processPendingUserMessages(run: AgentRun): void {
    if (run.pendingUserMessages.length === 0) return

    let combinedText = ''
    const allImages: string[] = []
    const visionAvailable = this.currentProfileHasVision()

    for (const pending of run.pendingUserMessages) {
      const userBody = Agent.formatTimestamp() + pending.message
      let imageNote = ''
      if (pending.images?.length) {
        const imageCount = pending.images.length
        log.info(`Supplement images: ${imageCount} image(s), vision=${visionAvailable}`)
        if (visionAvailable) {
          imageNote = t('agent.images_attached', { count: imageCount })
          allImages.push(...pending.images)
        } else {
          log.warn(`Dropping ${imageCount} supplement image(s) due to no vision capability on current profile`)
          imageNote = t('agent.user_image_no_vision', { count: imageCount })
        }
      }
      const msgPart = assembleUserMessageContent({
        userMessage: userBody,
        uploadedDocs: pending.documentContext,
        imageNote: imageNote || undefined,
      })
      combinedText += (combinedText ? '\n\n' : '') + msgPart
    }

    const userSupplementMsg: AiMessage = { role: 'user', content: combinedText }
    if (allImages.length > 0) {
      userSupplementMsg.images = allImages
    }
    run.messages.push(userSupplementMsg)
    run.taskMessageLog.push({ role: 'user', content: combinedText })

    if (this.currentPlan && !this.currentPlan.paused && this.currentPlan.steps.some(s => s.status === 'pending')) {
      const planHintMsg: AiMessage = { role: 'user', content: t('agent.user_supplement_with_plan'), _systemInjected: true }
      run.messages.push(planHintMsg)
      run.taskMessageLog.push({ ...planHintMsg })
    }

    run.pendingUserMessages = []
  }
  
  /**
   * 检查计划进度
   */
  protected checkPlanProgress(run: AgentRun): 'continue' | 'complete' {
    if (!this.currentPlan) {
      return 'complete'
    }
    
    if (this.currentPlan.paused) {
      return 'complete'
    }
    
    const pendingSteps = this.currentPlan.steps.filter(s => 
      s.status === 'pending' || s.status === 'in_progress'
    )
    
    if (pendingSteps.length > 0) {
      const stepTitles = pendingSteps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')
      const hint = t('agent.plan_incomplete', { count: pendingSteps.length, steps: stepTitles })
      const planMsg: AiMessage = { role: 'user', content: hint, _systemInjected: true }
      run.messages.push(planMsg)
      run.taskMessageLog.push({ ...planMsg })
      return 'continue'
    }
    
    return 'complete'
  }
  
  /**
   * 设置执行阶段
   *
   * 默认 'executing_command'；工具可以在 ToolDefinition._meta.phase 里声明覆盖
   *（如文件写入工具声明 'writing_file'，wait 工具声明 'waiting'）。基类不知道
   * 具体工具叫什么。
   */
  protected setExecutionPhase(run: AgentRun, toolName: string): void {
    const meta = getMetaByName(this.getAvailableTools(), toolName)
    run.executionPhase = meta?.phase ?? 'executing_command'
    run.currentToolName = toolName
  }
  
  /**
   * 等待用户确认
   */
  protected waitForConfirmation(
    run: AgentRun,
    toolCallId: string, 
    toolName: string, 
    toolArgs: Record<string, unknown>,
    riskLevel: RiskLevel,
    displayName?: string
  ): Promise<{ approved: boolean; modifiedArgs?: Record<string, unknown> }> {
    return new Promise((resolve) => {
      const confirmation: PendingConfirmationInternal = {
        agentId: run.id,
        toolCallId,
        toolName,
        toolArgs,
        riskLevel,
        displayName,
        resolve: (approved, modifiedArgs) => {
          run.pendingConfirmation = undefined
          run.executionPhase = 'thinking'
          resolve({ approved, modifiedArgs })
        }
      }
      
      run.pendingConfirmation = confirmation
      run.executionPhase = 'confirming'
      log.info(
        `[confirm] waiting (agent=${this._agentId ?? 'unknown'}, run=${run.id}, tool=${toolName}, toolCallId=${toolCallId}, risk=${riskLevel})`
      )
      this.callbacks?.onNeedConfirm?.(confirmation)
    })
  }
  
  /**
   * 请求安全输入（弹出前端安全输入框）。
   *
   * 前端弹框后，用户输入的值直接经 IPC 写入加密存储，Agent 只得到"已保存/已取消"。
   * 值的明文**不经过 LLM 上下文**。
   */
  protected requestSecureInput(
    run: AgentRun,
    skillId: string,
    envName: string,
    prompt: string,
    isUpdate?: boolean
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const requestId = this.generateId()
      const request: PendingSecureInputInternal = {
        agentId: run.id,
        requestId,
        skillId,
        envName,
        prompt,
        isUpdate,
        resolve: (saved) => {
          run.pendingSecureInput = undefined
          run.executionPhase = 'thinking'
          resolve(saved)
        }
      }
      run.pendingSecureInput = request
      run.executionPhase = 'confirming'
      this.callbacks?.onNeedSecureInput?.(request)
    })
  }

  // ==================== 私有方法 ====================
  
  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    const prefix = this._agentId ?? 'agent'
    return `${prefix}_${Date.now()}_${++this.idCounter}`
  }
  
  /**
   * 生成工具白名单键
   *
   * 默认整个 args 作为幂等键的一部分；工具可以在 ToolDefinition._meta.idempotencyKey
   * 里声明只取部分字段（如 execute_command/exec 只取 ['command']，让"同一条命令"
   * 的不同 cwd / timeout 共享白名单）。基类不知道具体工具叫什么。
   */
  private generateAllowedToolKey(toolName: string, toolArgs: Record<string, unknown>): string {
    const meta = getMetaByName(this.getAvailableTools(), toolName)
    const keyFields = meta?.idempotencyKey
    let keyArgs: Record<string, unknown> = toolArgs
    if (keyFields && keyFields.length > 0) {
      keyArgs = {}
      for (const f of keyFields) {
        keyArgs[f] = toolArgs[f]
      }
    }
    return `${toolName}:${JSON.stringify(keyArgs)}`
  }
  
  /**
   * 设置终端输出监听器
   */
  private setupOutputListener(run: AgentRun): void {
    if (!run.ptyId) return
    
    const MAX_BUFFER_LINES = 200
    const terminalService = this.services.unifiedTerminalService || this.services.ptyService
    
    run.outputUnsubscribe = terminalService.onData(run.ptyId, (data: string) => {
      const newLines = data.split('\n')
      run.realtimeOutputBuffer.push(...newLines)
      
      if (run.realtimeOutputBuffer.length > MAX_BUFFER_LINES) {
        run.realtimeOutputBuffer = run.realtimeOutputBuffer.slice(-MAX_BUFFER_LINES)
      }
    })
  }
  
  /**
   * 获取上下文长度
   */
  private getContextLength(): number {
    const configService = this.services.configService
    if (!configService) {
      return 128000  // 默认 128K
    }
    
    const profiles = configService.getAiProfiles()
    if (profiles.length === 0) {
      return 128000
    }
    
    let profile
    if (this.profileId) {
      profile = profiles.find(p => p.id === this.profileId)
    }
    if (!profile) {
      const activeId = configService.getActiveAiProfile()
      profile = profiles.find(p => p.id === activeId) || profiles[0]
    }
    
    // 返回配置的上下文长度，默认 128000
    return profile?.contextLength || 128000
  }
  
  /**
   * 估算文本的 token 数量
   */
  private estimateTokens(text: string | null | undefined): number {
    if (!text) return 0
    // 中文字符约 1.5 tokens/字
    // 非中文内容约 0.5 tokens/字符
    //   - 纯英文单词约 0.25，但实际内容含大量 URL、路径、标点、JSON、特殊符号，
    //     tokenizer 对这些切分很碎（每字符 0.5-1 token），取 0.5 作为均值
    //   - 实测：Excel 混合数据（URL + 中文 + 数字）0.5 系数与 API 实际计数误差 < 10%
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
    const otherChars = text.length - chineseChars
    return Math.ceil(chineseChars * 1.5 + otherChars * 0.5)
  }
  
  /**
   * 估算消息列表的总 token 数量
   */
  private estimateTotalTokens(messages: AiMessage[]): number {
    const MESSAGE_OVERHEAD = 4
    
    const messageTokens = messages.reduce((sum, msg) => {
      let tokens = this.estimateTokens(msg.content) + MESSAGE_OVERHEAD
      if (msg.tool_calls) {
        tokens += msg.tool_calls.reduce((t, tc) => 
          t + this.estimateTokens(tc.function.name) + this.estimateTokens(tc.function.arguments), 0)
      }
      if (msg.reasoning_content) {
        tokens += this.estimateTokens(msg.reasoning_content)
      }
      return sum + tokens
    }, 0)
    
    return messageTokens + 4000
  }
  
  /** 上下文管理功能激活阈值（用量百分比）
   *  与 85% 警告消息对齐：到了需要警告的时候才注册 compress_context 等工具，
   *  避免过早注册导致工具列表变化破坏前缀缓存。 */
  private static readonly CONTEXT_MGMT_THRESHOLD = 85

  // [缓存优化] 动态章节标题已禁用，见 updateContextPressure 中的注释
  // private static readonly CONTEXT_MGMT_HEADING = '\n\n## 运行环境'
  // private static readonly CONTEXT_STATUS_HEADING = '\n\n## 上下文状态'

  /**
   * 更新上下文压力状态：注入上下文状态 + 渐进式提醒
   * 
   * 设计原则：程序只提供信息，所有压缩决策由 AI 做。
   * - < 85%: 不干预（最大化前缀缓存命中）
   * - >= 85%: 注册上下文管理工具（compress_context 等）+ 注入警告消息到 messages 末尾
   * - API 自然报错: 最终兜底
   */
  private updateContextPressure(run: AgentRun): void {
    const contextLength = this.getContextLength()
    // 优先用 API 返回的精确值，无精确值时用估算值（仅用于内部上下文管理决策）
    const hasRealData = this._lastPromptTokens !== undefined
    const totalTokens = hasRealData ? this._lastPromptTokens! : this.estimateTotalTokens(run.messages)
    const usagePercent = Math.round((totalTokens / contextLength) * 100)
    const remaining = Math.max(0, contextLength - totalTokens)

    // 仅当有 API 返回的精确数据时才推送到前端，避免不准确的估算值误导用户
    if (hasRealData) {
      const steps = this.currentRun?.steps
      if (steps && steps.length > 0) {
        const lastStep = steps[steps.length - 1]
        lastStep.contextTokens = totalTokens
        if (this._lastCacheHitRate !== undefined) {
          lastStep.cacheHitRate = this._lastCacheHitRate
        }
        this.callbacks?.onStep?.(this.currentRun?.id || '', lastStep)
      }
    }

    // 超过阈值时激活上下文管理功能（一旦激活不会关闭，因为压缩后用量可能降低）
    if (!this.contextManagementEnabled && usagePercent >= Agent.CONTEXT_MGMT_THRESHOLD) {
      this.contextManagementEnabled = true
    }

    // [缓存优化] 以下「上下文状态注入系统提示词」已禁用。
    // 每轮 ReAct 循环中 token 用量数字都会变化，注入到系统提示词会破坏
    // DeepSeek/OpenAI/Anthropic 的前缀缓存（系统提示在所有历史消息之前，
    // 一旦变化会导致后续数万 tokens 的历史消息全部缓存未命中）。
    // 上下文压力由 85% 警告消息（注入到 messages 末尾）兜底。
    // 如需恢复：取消以下注释，并取消 prompt-builder.ts build() 中的 CACHE_BREAK_MARKER。
    //
    // const statusLines = [
    //   '## 上下文状态',
    //   `- 上下文窗口：${contextLength.toLocaleString()} tokens`,
    //   `- 当前用量：~${totalTokens.toLocaleString()} tokens（${usagePercent}%）`,
    //   `- 剩余容量：~${remaining.toLocaleString()} tokens`,
    //   `- 当前任务消息数：${taskMessageCount}`,
    // ]
    // if (usagePercent >= 85) {
    //   statusLines.push(`- ⚠️ 警告：...`)
    // } else if (usagePercent >= 70) {
    //   statusLines.push(`- 建议：...`)
    // }
    // if (run.messages.length > 0 && run.messages[0].role === 'system') {
    //   const systemContent = run.messages[0].content || ''
    //   const mgmtIdx = systemContent.indexOf(Agent.CONTEXT_MGMT_HEADING)
    //   const statusIdx = systemContent.indexOf(Agent.CONTEXT_STATUS_HEADING)
    //   const cutPoints = [mgmtIdx, statusIdx].filter(i => i !== -1)
    //   const cutPoint = cutPoints.length > 0 ? Math.min(...cutPoints) : -1
    //   let content = cutPoint !== -1 ? systemContent.substring(0, cutPoint) : systemContent
    //   if (this.contextManagementEnabled) {
    //     content += PromptBuilder.buildContextManagementSection()
    //     content += '\n\n' + statusLines.join('\n')
    //   }
    //   run.messages[0].content = content
    // }

    // 85%+ 额外注入警告消息（避免重复注入）
    if (usagePercent >= 85) {
      const lastMsg = run.messages[run.messages.length - 1]
      const isAlreadyWarned = lastMsg?.role === 'user' && 
        typeof lastMsg.content === 'string' && 
        lastMsg.content.includes('[系统] 上下文用量告警')
      
      if (!isAlreadyWarned) {
        run.messages.push({
          role: 'user',
          content: t('agent.context_pressure_warning', {
            percentage: usagePercent,
            remaining: remaining.toLocaleString()
          }),
          _systemInjected: true
        })
      }
    }
  }
  
  /**
   * 压缩当前任务的对话上下文
   * 将早期的 assistant + tool 消息归档，替换为 AI 提供的摘要
   */
  private compressCurrentContext(
    run: AgentRun,
    summary: string,
    keepRecent: number
  ): { beforeTokens: number; afterTokens: number; freedTokens: number; archiveId: string } | null {
    // 找到当前任务的消息范围（最后一条 user 消息之后的部分）
    let lastUserIndex = -1
    for (let i = run.messages.length - 1; i >= 0; i--) {
      if (run.messages[i].role === 'user') {
        // 跳过系统注入的警告消息
        if (typeof run.messages[i].content === 'string' &&
            run.messages[i].content!.includes('[系统] 上下文用量告警')) {
          continue
        }
        lastUserIndex = i
        break
      }
    }

    if (lastUserIndex === -1) return null

    // 当前任务的消息（user 消息之后到末尾）
    const taskMessages = run.messages.slice(lastUserIndex + 1)

    // 计算需要保留的消息数量
    // 一组 = assistant 消息 + 对应的 tool result 消息
    // 从后往前数 keepRecent 组
    let keepFromIndex = taskMessages.length
    let groupCount = 0
    for (let i = taskMessages.length - 1; i >= 0; i--) {
      if (taskMessages[i].role === 'assistant') {
        groupCount++
        if (groupCount >= keepRecent) {
          keepFromIndex = i
          break
        }
      }
    }

    // 需要压缩的消息
    const toCompress = taskMessages.slice(0, keepFromIndex)
    if (toCompress.length === 0) return null

    const beforeTokens = this.estimateTotalTokens(run.messages)

    // 生成归档 ID
    if (!run.compressedArchives) {
      run.compressedArchives = []
    }
    const archiveId = `ca-${run.compressedArchives.length + 1}`

    // 归档原始消息（深拷贝，防止后续 run.messages 修改影响归档）
    run.compressedArchives.push({
      id: archiveId,
      messages: JSON.parse(JSON.stringify(toCompress)),
      summary,
      timestamp: Date.now()
    })

    // 替换：用一条摘要消息替换被压缩的消息
    const summaryMessage: AiMessage = {
      role: 'assistant',
      content: `[早期对话已压缩，归档 ID: "${archiveId}"。如需查看原始内容，请调用 recall_compressed(archive_id: "${archiveId}")。]\n\n${summary}`
    }

    // 重建 messages: system + 历史任务消息 + user + 摘要 + 保留的最近消息
    const preserved = taskMessages.slice(keepFromIndex)
    run.messages = [
      ...run.messages.slice(0, lastUserIndex + 1),
      summaryMessage,
      ...preserved
    ]

    const afterTokens = this.estimateTotalTokens(run.messages)

    return {
      beforeTokens,
      afterTokens,
      freedTokens: beforeTokens - afterTokens,
      archiveId
    }
  }

  /**
   * 修复不完整的工具调用序列
   * 当用户中断或运行抛错时，可能存在 assistant 消息（含 tool_calls）但缺少对应的 tool result。
   * 同时镜像写入 taskMessageLog，确保下次任务的 cache path / cold start 看到的对话序列合法。
   *
   * @param placeholder 占位 tool result 的内容（默认按"用户中断"语义；错误路径应传入更具体的描述）
   */
  private fixIncompleteToolCalls(run: AgentRun, placeholder: string = '[操作被用户中断]'): void {
    const { messages } = run
    if (messages.length === 0) return

    // 从后往前查找最后一个带有 tool_calls 的 assistant 消息
    let lastAssistantWithToolCallsIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        lastAssistantWithToolCallsIndex = i
        break
      }
      // 如果遇到 user 消息，说明之前的对话是完整的
      if (msg.role === 'user') break
    }

    if (lastAssistantWithToolCallsIndex === -1) return

    const assistantMsg = messages[lastAssistantWithToolCallsIndex]
    const toolCalls = assistantMsg.tool_calls!

    // 收集该 assistant 消息之后已有的 tool result
    const existingToolCallIds = new Set<string>()
    for (let i = lastAssistantWithToolCallsIndex + 1; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.role === 'tool' && msg.tool_call_id) {
        existingToolCallIds.add(msg.tool_call_id)
      }
    }

    // 为缺失的 tool_call_id 添加占位的 tool result
    const missingToolCalls = toolCalls.filter(tc => !existingToolCallIds.has(tc.id))
    if (missingToolCalls.length > 0) {
      log.info(`修复 ${missingToolCalls.length} 个缺失的 tool result 消息`)
      for (const tc of missingToolCalls) {
        const toolMsg: AiMessage = {
          role: 'tool',
          content: placeholder,
          tool_call_id: tc.id
        }
        messages.push(toolMsg)
        // 镜像写入 taskMessageLog：保持 append-only 的对话日志与 messages 同步，
        // 否则 TaskMemory 持久化的 messages 会缺失 tool result，下次任务复用时序列违法
        run.taskMessageLog.push({ ...toolMsg })
      }
    }
  }
  
  /**
   * 根据程序设置的语言生成语言提示
   */
  private getLanguageHint(): string {
    const locale = this.services.configService?.getLanguage() || 'zh-CN'
    if (locale === 'en-US') {
      return '[Respond in English]\n'
    }
    return ''  // 中文不需要特别提示
  }
  
  /**
   * 增强用户消息
   */
  private enhanceUserMessage(message: string): string {
    const languageHint = this.getLanguageHint()
    return languageHint + Agent.formatTimestamp() + message
  }

  /** 生成用户消息时间戳前缀，格式如 [2026-03-25 22:30 周二] */
  static formatTimestamp(): string {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} ${weekdays[now.getDay()]}`
    return `[${ts}] `
  }

  private resolveBondContext(): string | undefined {
    try {
      return getBondService().getBondContext()
    } catch {
      return undefined
    }
  }
}
