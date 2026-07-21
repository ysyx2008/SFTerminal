/**
 * Watch Service - 关注点管理与执行引擎
 *
 * 核心职责：
 * 1. Watch CRUD 管理
 * 2. 监听事件总线，匹配 Watch 触发条件
 * 3. 通过 Agent 执行 Watch 的 prompt
 * 4. 将结果投递到配置的输出渠道
 * 5. 管理 cron/interval 类型触发器的定时调度
 */
import * as fs from 'fs'
import * as path from 'path'
import type { BrowserWindow } from 'electron'
import { Notification } from 'electron'
import { createLogger } from '../../utils/logger'
import { Companion } from '../conversation/companion'
import { getDefaultShell, getLocalOS } from '../../utils/platform'
import { getWorkspacePath } from '../agent/tools/file'
import { renderTodosForContext } from '../agent/skills/todo/render'
import { getIMService } from '../im/im.service'
import type {
  WatchDefinition,
  CreateWatchParams,
  WatchTrigger,
  WatchRunRecord,
  WatchRunStatus
} from './types'

const log = createLogger('WatchService')
import { WatchStore, getWatchStore } from './store'
import type { SensorEvent, EventHandler } from '../sensor/types'
import { getEventBus } from '../sensor/event-bus'
import { EventPool } from './event-pool'
import type { ConfigService, SshSession } from '../config.service'
import type { AgentService } from '../agent'
import type { AgentContext, AgentCallbacks, AgentStep } from '../agent/types'
import type { AiService } from '../ai.service'
import type { SensorService } from '../sensor'
import type { HistoryService } from '../history.service'
import { isWatchAgentKey, watchAgentKeyFor, WAKEUP_AGENT_KEY } from '@shared/types'
import { watchTemplates, getTemplateById, getAllTemplateCategories, type WatchTemplate } from './templates'

// cron-parser 动态导入
let CronExpressionParser: any = null

// ==================== 常量 ====================

const MIN_INTERVAL_SECONDS = 10
const MAX_INTERVAL_SECONDS = 7 * 24 * 3600 // 7 days
const DEFAULT_TIMEOUT_SECONDS = 300
const MAX_OUTPUT_LENGTH = 1000
/** 不同 Watch 全局并发软上限（含 wakeup）；超额排队不丢弃 */
const DEFAULT_MAX_CONCURRENT_WATCHES = 5

// ==================== 类型 ====================

export interface WatchServiceConfig {
  configService: ConfigService
  agentService: AgentService
  aiService: AiService
  sensorService: SensorService
  historyService?: HistoryService
  mainWindow: BrowserWindow | null
}

export interface WatchExecutionResult {
  success: boolean
  output: string
  error?: string
  duration: number
  skipped?: boolean
  skipReason?: string
  steps?: AgentStep[]
  /** Agent 通过 talk_to_user 产生的用户可见消息（与内部 output 分离） */
  userMessage?: string
}

// ==================== Watch Service ====================

export class WatchService {
  private store: WatchStore
  private config: WatchServiceConfig | null = null
  private timers: Map<string, NodeJS.Timeout> = new Map()
  private runningWatches: Map<string, { watchId: string; startTime: number; agentId: string }> = new Map()
  /** 已入队/待槽位的 watchId，防止同 Watch 在排队期间被重复调度 */
  private scheduledWatches: Set<string> = new Set()
  private activeCount = 0
  private waitQueue: Array<() => void> = []
  private maxConcurrent = DEFAULT_MAX_CONCURRENT_WATCHES
  private isRunning = false
  private eventHandler: EventHandler | null = null
  private eventPool: EventPool | null = null
  private checkInterval: NodeJS.Timeout | null = null

  constructor() {
    this.store = getWatchStore()
  }

  init(config: WatchServiceConfig): void {
    this.config = config
    log.info('Initialized')
  }

  async start(): Promise<void> {
    if (this.isRunning) return

    // 动态加载 cron-parser
    if (!CronExpressionParser) {
      try {
        const mod = await import('cron-parser')
        CronExpressionParser = (mod as any).default || (mod as any).CronExpressionParser
      } catch (e) {
        log.error('Failed to load cron-parser:', e)
        throw new Error('cron-parser module not available')
      }
    }

    this.isRunning = true

    // 通过 EventPool 订阅事件总线（分流即时/攒批事件）
    const eventBus = getEventBus()
    this.eventHandler = (event) => this.handleEvent(event)
    const drainMinutes = this.config?.configService
      ? this.config.configService.get('watchEventPoolDrainMinutes')
      : 15
    const quietHours = this.config?.configService
      ? this.config.configService.get('watchQuietHours')
      : null
    this.eventPool = new EventPool(this.eventHandler, {
      drainIntervalMs: (drainMinutes || 15) * 60 * 1000,
      quietHours
    })
    this.eventPool.onAfterDrain(() => {
      this.config?.sensorService.email.saveState()
    })
    this.eventPool.attach(eventBus)

    // 调度触发器 + 注册传感器 target
    const watches = this.store.getAll()
    for (const watch of watches) {
      if (watch.enabled) {
        this.scheduleTimeTriggers(watch)
        this.registerSensorTargets(watch)
      }
    }

    // 每分钟检查遗漏的调度
    this.checkInterval = setInterval(() => this.checkMissedSchedules(), 60 * 1000)

    log.info(`Started with ${watches.filter(w => w.enabled).length} active watches`)
  }

  stop(): void {
    if (!this.isRunning) return
    this.isRunning = false

    // 取消事件订阅
    if (this.eventPool) {
      this.eventPool.detach(getEventBus())
      this.eventPool = null
    }
    this.eventHandler = null

    // 清除所有定时器
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()

    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }

    // 清理所有传感器 target
    const allWatches = this.store.getAll()
    for (const watch of allWatches) {
      this.unregisterSensorTargets(watch.id)
    }

    // 丢弃排队等待者并重置并发槽，避免 stop 后仍被 releaseSlot 唤醒执行
    const pendingWaiters = this.waitQueue.splice(0)
    this.scheduledWatches.clear()
    this.activeCount = 0
    for (const resolve of pendingWaiters) resolve()

    // 中止正在运行的 Watch Agent
    if (this.runningWatches.size > 0 && this.config) {
      for (const [watchId, info] of this.runningWatches) {
        log.info(`Aborting running watch: ${watchId}`)
        try {
          this.config.agentService.abort(info.agentId)
        } catch { /* ignore */ }
      }
      this.runningWatches.clear()
    }

    log.info('Stopped')
  }

  // ==================== Watch CRUD ====================

  getAll(): WatchDefinition[] {
    return this.store.getAll()
  }

  get(id: string): WatchDefinition | undefined {
    return this.store.get(id)
  }

  create(params: CreateWatchParams): WatchDefinition {
    this.validateParams(params)

    // 为 webhook 触发器生成 token
    const triggers = params.triggers.map(t => {
      if (t.type === 'webhook' && !t.token) {
        return { ...t, token: this.generateToken() }
      }
      return t
    })

    const watch = this.store.create({ ...params, triggers })

    if (watch.enabled && this.isRunning) {
      this.scheduleTimeTriggers(watch)
      this.registerSensorTargets(watch)
    }

    log.info(`Created watch: ${watch.name} (${watch.id})`)
    return watch
  }

  update(id: string, updates: Partial<CreateWatchParams>): WatchDefinition | null {
    if (updates.triggers) {
      this.validateTriggers(updates.triggers)
    }
    const watch = this.store.update(id, updates)
    if (watch) {
      this.cancelTimers(id)
      this.unregisterSensorTargets(id)
      if (watch.enabled && this.isRunning) {
        this.scheduleTimeTriggers(watch)
        this.registerSensorTargets(watch)
      }
    }
    return watch
  }

  delete(id: string): boolean {
    this.cancelTimers(id)
    this.unregisterSensorTargets(id)
    return this.store.delete(id)
  }

  toggle(id: string): WatchDefinition | null {
    const watch = this.store.toggle(id)
    if (watch) {
      if (watch.enabled && this.isRunning) {
        this.scheduleTimeTriggers(watch)
        this.registerSensorTargets(watch)
      } else {
        this.cancelTimers(id)
        this.unregisterSensorTargets(id)
      }
    }
    return watch
  }

  getHistory(watchId?: string, limit?: number) {
    return this.store.getHistory(watchId, limit)
  }

  clearHistory(watchId?: string) {
    this.store.clearHistory(watchId)
  }

  // ==================== 模板 ====================

  getTemplates(): WatchTemplate[] {
    return watchTemplates
  }

  getTemplateCategories() {
    return getAllTemplateCategories()
  }

  createFromTemplate(templateId: string, options?: Record<string, unknown>): WatchDefinition {
    const template = getTemplateById(templateId)
    if (!template) {
      throw new Error(`Template not found: ${templateId}`)
    }
    const params = template.create(options)
    return this.create(params)
  }

  /** 手动触发 Watch */
  async triggerWatch(id: string): Promise<WatchExecutionResult> {
    const watch = this.store.get(id)
    if (!watch) {
      return { success: false, output: '', error: 'Watch not found', duration: 0 }
    }

    // 唤醒关切：通过 drain 事件池触发，使其能看到池中积累的事件（或空 batch 做例行检查）
    if (id === WatchService.WAKEUP_ID && this.eventPool) {
      await this.eventPool.drain(true, { fromManualCheck: true })
      return { success: true, output: '', error: '', duration: 0, skipped: false }
    }

    if (this.runningWatches.has(id) || this.scheduledWatches.has(id)) {
      return { success: false, output: '', error: 'Watch already running', duration: 0, skipped: true, skipReason: 'already_running' }
    }

    const event: SensorEvent = {
      id: `manual-${Date.now().toString(36)}`,
      type: 'manual',
      source: 'user',
      timestamp: Date.now(),
      watchId: id,
      payload: {},
      priority: watch.priority
    }

    return this.dispatchWatch(watch, event)
  }

  /** 更新 Watch 的工作流状态 */
  updateWatchState(id: string, state: Record<string, unknown>): void {
    this.store.updateState(id, state)
  }

  isWatchRunning(id: string): boolean {
    return this.runningWatches.has(id)
  }

  getRunningWatches(): string[] {
    return Array.from(this.runningWatches.keys())
  }

  /**
   * 取消正在执行的关切（abort `__watch__:${id}` / `__wakeup__` Agent）。
   * runningWatches 条目由 executeWatch 的 finally 清理。
   */
  cancelRunningWatch(id: string): boolean {
    const info = this.runningWatches.get(id)
    if (!info || !this.config) return false

    try {
      this.config.agentService.abort(info.agentId)
      log.info(`Cancelled running watch: ${id}`)
      return true
    } catch (e) {
      log.warn(`Failed to cancel watch ${id}:`, e)
      return false
    }
  }

  getSshSessions(): SshSession[] {
    return this.config?.configService.getSshSessions() || []
  }

  // ==================== 事件处理 ====================

  /**
   * 匹配并派发 Watch 执行。派发后即返回（不等待执行结束），
   * 以便 EventBus / EventPool 继续处理后续事件；真正的并发由调度器控制。
   */
  private async handleEvent(event: SensorEvent): Promise<void> {
    const watches = this.findMatchingWatches(event)
    if (watches.length === 0) return

    log.info(`Event ${event.type} matched ${watches.length} watch(es)`)

    for (const watch of watches) {
      if (watch.expiresAt && watch.expiresAt < Date.now()) {
        log.info(`Watch expired: ${watch.name}`)
        this.store.update(watch.id, { enabled: false })
        continue
      }

      if (this.runningWatches.has(watch.id) || this.scheduledWatches.has(watch.id)) {
        log.info(`Watch already running/scheduled: ${watch.name}`)
        continue
      }

      void this.dispatchWatch(watch, event).catch(err => {
        log.error(`Watch dispatch failed: ${watch.name}`, err)
      })
    }
  }

  private findMatchingWatches(event: SensorEvent): WatchDefinition[] {
    // 如果事件指定了 watchId，只匹配该 Watch
    if (event.watchId) {
      const watch = this.store.get(event.watchId)
      return watch?.enabled ? [watch] : []
    }

    // 按事件类型匹配
    return this.store.getAll().filter(w =>
      w.enabled && w.triggers.some(t => t.type === event.type)
    )
  }

  // ==================== 并发调度 ====================

  private acquireSlot(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++
      return Promise.resolve()
    }
    // 唤醒时由 releaseSlot 转让槽位，不再二次 ++
    return new Promise(resolve => {
      this.waitQueue.push(resolve)
    })
  }

  private releaseSlot(): void {
    const next = this.waitQueue.shift()
    if (next) {
      next()
    } else if (this.activeCount > 0) {
      this.activeCount--
    }
  }

  /** 占用并发槽后执行；调用方负责同 Watch 去重（scheduled/running） */
  private async dispatchWatch(watch: WatchDefinition, event: SensorEvent): Promise<WatchExecutionResult> {
    this.scheduledWatches.add(watch.id)
    try {
      await this.acquireSlot()
      if (!this.isRunning) {
        this.releaseSlot()
        return {
          success: false, output: '', error: 'WatchService stopped', duration: 0,
          skipped: true, skipReason: 'stopped'
        }
      }
      try {
        return await this.executeWatch(watch, event)
      } finally {
        this.releaseSlot()
      }
    } finally {
      this.scheduledWatches.delete(watch.id)
    }
  }

  // ==================== 执行引擎 ====================

  private static readonly AUTO_TRIGGER_TYPES = new Set([
    'heartbeat', 'cron', 'interval', 'email', 'calendar', 'file_change', 'im_connected',
    'command_probe', 'http_probe', 'app_lifecycle', 'milestone', 'watch_failure'
  ])

  private async executeWatch(watch: WatchDefinition, event: SensorEvent): Promise<WatchExecutionResult> {
    if (!this.config) {
      return { success: false, output: '', error: 'WatchService not initialized', duration: 0 }
    }

    const startTime = Date.now()
    const enhancedPrompt = this.buildEnhancedPrompt(watch, event)
    const isWakeup = watch.id === WatchService.WAKEUP_ID
    // 静默仅约束对外派发：唤醒始终静默；desktop 自动触发不走框架兜底通知
    const isSilent = isWakeup
      ? true
      : (watch.output.type === 'desktop'
        && WatchService.AUTO_TRIGGER_TYPES.has(event.type)
        && !event.payload?.fromManualCheck)

    const agentSessionId = `watch_${watch.id}_${Date.now()}`
    const agentId = isWakeup
      ? WatchService.WAKEUP_AGENT_ID
      : watchAgentKeyFor(watch.id)

    if (watch.execution.type === 'ssh') {
      log.warn(
        `Watch "${watch.name}" (${watch.id}) has execution.type=ssh; ` +
        `dedicated SSH PTY path removed — running as local assistant`
      )
    }

    let result: WatchExecutionResult

    try {
      // 手动 desktop：确保联络 tab 存在（talk_to_user / 兜底通知可落点）
      if (!isWakeup && watch.output.type === 'desktop' && !isSilent) {
        this.ensureDesktopTab()
      }

      this.notifyFrontend('watch:task-started', {
        watchId: watch.id,
        ptyId: null,
        watchName: watch.name,
        prompt: enhancedPrompt,
        triggerType: event.type,
        executionType: 'assistant'
      })

      this.runningWatches.set(watch.id, { watchId: watch.id, startTime, agentId })
      result = await this.executeWithAssistantAgent(
        watch, enhancedPrompt, isSilent, isWakeup, agentSessionId
      )
    } catch (error) {
      result = {
        success: false, output: '',
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      }
    } finally {
      this.runningWatches.delete(watch.id)
    }

    this.recordExecution(watch, event, result, agentSessionId)

    if (!result.success && !result.skipped) {
      this.notifyFailure(watch, result)
    } else {
      await this.deliverOutput(watch, result, isSilent)
    }

    this.notifyFrontend('watch:task-completed', {
      watchId: watch.id,
      result: {
        success: result.success,
        output: result.output.substring(0, MAX_OUTPUT_LENGTH),
        error: result.error, duration: result.duration,
        skipped: result.skipped, skipReason: result.skipReason
      }
    })

    return result
  }

  /**
   * 关切一律本机助手 Agent 执行（不再绑专用 PTY）。
   * @param silent 仅影响对外派发 / 主聊天 complete；步骤始终推关切面板
   * @param wakeupMode 唤醒：不发 agent:complete/error；agentId 用 `__wakeup__`
   */
  private async executeWithAssistantAgent(
    watch: WatchDefinition,
    prompt: string,
    silent: boolean = false,
    wakeupMode: boolean = false,
    agentSessionId?: string
  ): Promise<WatchExecutionResult> {
    if (!this.config?.agentService) {
      return { success: false, output: '', error: 'Agent service not available', duration: 0 }
    }

    const startTime = Date.now()
    // wakeup 用独立 Agent（保留跨执行工作记忆）；普通 watch 用 `__watch__:${watchId}` 以支持并发
    const agentId = wakeupMode
      ? WatchService.WAKEUP_AGENT_ID
      : watchAgentKeyFor(watch.id)
    const mainWindow = this.config.mainWindow
    let hasError = false
    let errorMessage = ''
    const steps: AgentStep[] = []

    // 每次 Watch 执行使用独立 session；普通 watch 保留工作记忆但分开存储步骤，
    // wakeup 同样新起 session（@suppressSeed 门控回种，仅保留 TaskMemory 重建）
    this.config.agentService.startNewSession(agentId)

    // 真正预加载 watch.skills（prompt 里的「预加载技能」文案不足以保证工具可用）
    if (watch.skills && watch.skills.length > 0) {
      try {
        await this.config.agentService.preloadSkills(agentId, watch.skills)
      } catch (e) {
        log.warn('Failed to preload watch skills:', e)
      }
    }

    // 过程透明：一律推 agent:step 到关切面板
    // complete/error 仅非唤醒、非静默时发（避免污染主聊天；自动触发靠 talk_to_user）
    const shouldSendCompletion = !wakeupMode && !silent

    const callbacks: AgentCallbacks = {
      onStep: (_runId: string, step: AgentStep) => {
        const existingIdx = steps.findIndex(s => s.id === step.id)
        if (existingIdx >= 0) {
          steps[existingIdx] = step
        } else {
          steps.push(step)
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:step', {
            agentId, step: JSON.parse(JSON.stringify(step)),
            ...(wakeupMode ? { wakeup: true } : {})
          })
        }
        if (step.type === 'error') {
          hasError = true
          if (!errorMessage) errorMessage = step.content
        }
      },
      onComplete: (_runId: string, result: string, pendingUserMessages?: string[]) => {
        if (shouldSendCompletion && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:complete', { agentId, result, pendingUserMessages })
        }
      },
      onError: (_runId: string, error: string) => {
        hasError = true
        errorMessage = error || errorMessage
        if (shouldSendCompletion && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:error', { agentId, error })
        }
      }
    }

    try {
      const context: AgentContext = {
        terminalOutput: [],
        systemInfo: { os: getLocalOS(), shell: getDefaultShell() },
        terminalType: 'assistant',
        sessionId: agentSessionId,
        ...(watch.execution.workingDirectory ? { cwd: watch.execution.workingDirectory } : {}),
        ...(wakeupMode ? { wakeup: true } : {})
      }

      const timeoutMs = (watch.execution.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000
      let timeoutHandle: NodeJS.Timeout | null = null

      const agentResult = await Promise.race([
        this.config.agentService.runAssistant(agentId, prompt, context, {
          enabled: true, commandTimeout: 30000,
          autoExecuteSafe: true, autoExecuteModerate: true,
          // 后台关切无确认 UI（面板隐藏 confirm），必须 free，否则会卡在 dangerous 工具上
          executionMode: 'free', debugMode: false
        }, undefined, callbacks),
        new Promise<string>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(`Watch timeout (${watch.execution.timeout ?? 300}s)`)), timeoutMs)
        })
      ]).finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle) })

      return {
        success: !hasError,
        output: (agentResult || '').trim(),
        error: hasError ? errorMessage : undefined,
        duration: Date.now() - startTime,
        steps,
        userMessage: this.extractUserMessage(steps)
      }
    } catch (error) {
      try { this.config.agentService.abort(agentId) } catch { /* ignore */ }
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
        steps: [],
        userMessage: undefined
      }
    }
  }

  // ==================== Prompt 构建 ====================

  private buildEnhancedPrompt(watch: WatchDefinition, event: SensorEvent): string {
    // 唤醒 Watch：HEARTBEAT.md 模板 + 最近联络上下文（与「其它 Watch」同源，避免心跳看不到联络 tab 对话）
    if (watch.id === WatchService.WAKEUP_ID) {
      const template = this.readWorkspaceFile(WatchService.HEARTBEAT_FILENAME)
        || WatchService.DEFAULT_HEARTBEAT_TEMPLATE
      const parts = [this.resolveHeartbeatVariables(template, watch, event)]
      const recentContext = this.buildRecentCompanionContext()
      if (recentContext) {
        parts.push(recentContext)
      }
      return parts.join('\n\n')
    }

    // 其他 Watch：保持原有逻辑
    const parts: string[] = []

    parts.push(`[当前时间：${new Date().toLocaleString()}]`)

    const eventLines = this.formatEventLines(event)
    if (eventLines.length) {
      parts.push(`触发事件：\n${eventLines.join('\n')}`)
      if (eventLines.length > 1) {
        parts.push('[如果这些事件都不值得通知用户，直接回复 "NO_ACTION" 即可。这些事件会被丢弃，下次再看。]')
      }
    }

    const hasState = watch.state && Object.keys(watch.state).length > 0
    if (hasState) {
      parts.push(`[当前 Watch 状态：${JSON.stringify(watch.state).substring(0, 500)}]`)
      parts.push('[需要更新状态时，调用 watch_state_update 工具。]')
    }

    if (watch.skills && watch.skills.length > 0) {
      parts.push(`[预加载技能：${watch.skills.join(', ')}]`)
    }

    const recentContext = this.buildRecentCompanionContext()
    if (recentContext) {
      parts.push(recentContext)
    }

    parts.push('[通知用户时，必须调用 talk_to_user 工具发送消息。最终文本回复仅作为内部日志，不会作为通知正文。]')
    parts.push(watch.prompt)

    return parts.join('\n')
  }

  /** 最近联络上下文短期缓存：避免每次 Watch 触发都同步读盘解析整条会话记录 */
  private companionContextCache?: { text: string; expires: number }
  private static readonly COMPANION_CONTEXT_TTL_MS = 10_000

  /**
   * 构建最近联络上下文：让 Watch 发消息前知道最近跟用户聊了什么，避免重复通知 / 保持连贯。
   * 数据源是 __companion__ 的最近会话记录——与 IM/Gateway/桌面/主动通知共享同一条联络对话。
   * 带 10s TTL 缓存：联络记录可能很大，频繁触发的 Watch 不必每次都同步读盘解析。
   */
  private buildRecentCompanionContext(): string {
    const now = Date.now()
    if (this.companionContextCache && this.companionContextCache.expires > now) {
      return this.companionContextCache.text
    }
    const text = this.computeRecentCompanionContext()
    this.companionContextCache = { text, expires: now + WatchService.COMPANION_CONTEXT_TTL_MS }
    return text
  }

  private computeRecentCompanionContext(): string {
    try {
      const historyService = this.config?.historyService
      if (!historyService) return ''
      return new Companion(historyService, WatchService.COMPANION_AGENT_ID)
        .formatRecentTurnsForWatchPrompt()
    } catch {
      return ''
    }
  }

  /** talk_to_user 落盘后失效缓存，避免短间隔连触发读到过期联络上下文 */
  invalidateCompanionContextCache(): void {
    this.companionContextCache = undefined
  }

  /** 解析心跳模板变量，缺失的必要变量自动追加到开头 */
  private resolveHeartbeatVariables(template: string, watch: WatchDefinition, event: SensorEvent): string {
    let result = template

    const timeValue = `[当前时间：${new Date().toLocaleString()}]`

    const eventLines = this.formatEventLines(event)
    let eventsValue = ''
    if (eventLines.length) {
      eventsValue = `# 触发事件\n${eventLines.join('\n')}`
      if (eventLines.length > 1) {
        eventsValue += '\n[这些事件都不值得通知用户的话，直接回复 "NO_ACTION"，事件会被丢弃，下次再看。]'
      }
    }

    const todoValue = renderTodosForContext()

    const activityDigest = this.buildRecentActivityDigest()
    const activityValue = activityDigest
      ? `# 用户近况\n${activityDigest}`
      : ''

    result = result.replace('{{TIME}}', timeValue)
    result = result.replace('{{EVENTS}}', eventsValue)
    result = result.replace('{{TODO}}', todoValue)
    result = result.replace('{{ACTIVITY}}', activityValue)

    return result.replace(/\n{3,}/g, '\n\n').trim()
  }

  private static readonly WORKSPACE_FILE_MAX_CHARS = 8000

  private static readonly DIGEST_MAX_RECORDS = 10
  private static readonly DIGEST_DAYS = 3
  private static readonly DIGEST_TASK_MAX_CHARS = 100
  private static readonly DIGEST_RESULT_MAX_CHARS = 150

  private buildRecentActivityDigest(): string | null {
    const historyService = this.config?.historyService
    if (!historyService) return null

    try {
      const now = new Date()
      const since = new Date(now.getTime() - WatchService.DIGEST_DAYS * 24 * 60 * 60 * 1000)
      const startDate = since.toISOString().split('T')[0]

      const allRecords = historyService.getAgentRecords(startDate)
      // 活动摘要只看用户任务/联络，排除关切/唤醒内心独白
      const userRecords = allRecords.filter(r =>
        r.terminalId &&
        r.terminalId !== '' &&
        !isWatchAgentKey(r.agentKey) &&
        r.agentKey !== WAKEUP_AGENT_KEY
      )

      if (userRecords.length === 0) return null

      const recent = userRecords.slice(-WatchService.DIGEST_MAX_RECORDS)
      const lines: string[] = []

      for (const r of recent) {
        const time = new Date(r.timestamp).toLocaleString('zh-CN', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
        })
        const source = r.terminalType === 'assistant' ? '助手' : '终端'
        const task = this.truncate(r.userTask || '(未知任务)', WatchService.DIGEST_TASK_MAX_CHARS)
        const statusIcon = r.status === 'completed' ? '✓' : r.status === 'failed' ? '✗' : '…'

        let line = `- ${time} (${source}) ${statusIcon} ${task}`
        if (r.finalResult) {
          const result = this.truncate(r.finalResult, WatchService.DIGEST_RESULT_MAX_CHARS)
          line += `\n  → ${result}`
        }
        lines.push(line)
      }

      if (userRecords.length > recent.length) {
        lines.push(`(仅显示最近 ${recent.length} 条，共 ${userRecords.length} 条)`)
      }

      return lines.join('\n')
    } catch (e) {
      log.warn('构建用户近况摘要失败:', e)
      return null
    }
  }

  private truncate(text: string, maxLen: number): string {
    const oneLine = text.replace(/\n/g, ' ').trim()
    if (oneLine.length <= maxLen) return oneLine
    // 按 code point 切（Array.from 把 surrogate pair 当一个元素），避免在 emoji
    // 中间切出孤立 surrogate，导致 JSON.stringify 输出不完整的 \uXXXX 转义，
    // 进而被 DeepSeek 等严格 JSON 解析器拒绝（"unexpected end of hex escape"）。
    const codePoints = Array.from(oneLine)
    if (codePoints.length <= maxLen) return oneLine
    return codePoints.slice(0, maxLen).join('') + '...'
  }

  private readWorkspaceFile(filename: string): string | null {
    try {
      const filePath = path.join(getWorkspacePath(), filename)
      const raw = fs.readFileSync(filePath, 'utf-8').trim()
      if (!raw) return null
      if (raw.length <= WatchService.WORKSPACE_FILE_MAX_CHARS) return raw
      const lastNewline = raw.lastIndexOf('\n', WatchService.WORKSPACE_FILE_MAX_CHARS)
      const cutPoint = lastNewline > 0 ? lastNewline : WatchService.WORKSPACE_FILE_MAX_CHARS
      return raw.slice(0, cutPoint) + `\n... [文件较大，以上为前 ${cutPoint} 字符，完整内容请用 read_file 工具读取 ${filePath}]`
    } catch (e: any) {
      if (e?.code !== 'ENOENT') {
        log.warn(`读取 ${filename} 失败:`, e)
      }
      return null
    }
  }

  private formatEventLines(event: SensorEvent): string[] {
    // 批量事件：展开子事件
    if (event.type === 'heartbeat' && event.payload.isBatch) {
      const subEvents = event.payload.events as Array<{ type: string; source: string; timestamp: number; payload: Record<string, unknown> }> | undefined
      if (!subEvents?.length) return ['- 例行检查（传感器未检测到新的邮件、日历或文件变化）']
      return subEvents.slice(0, 20).map((e, i) => `  ${i + 1}. ${this.describeEvent(e.type, e.payload)}`)
    }
    // 单个事件
    if (event.type === 'heartbeat') return ['- 例行检查']
    return [`- ${this.describeEvent(event.type, event.payload)}`]
  }

  private describeEvent(type: string, payload: Record<string, unknown>): string {
    switch (type) {
      case 'email':
        return `邮件 来自 ${payload.fromName || payload.from}："${payload.subject}"`
      case 'calendar':
        return `日历 "${payload.summary}" ${payload.minutesUntilStart}分钟后开始${payload.location ? `（${payload.location}）` : ''}`
      case 'file_change':
        return `文件变更 ${payload.changeType}：${payload.directory}/${payload.filename}`
      case 'webhook':
        return `Webhook${Object.keys(payload).length ? `：${JSON.stringify(payload).substring(0, 500)}` : ''}`
      case 'manual':
        return '用户手动触发'
      case 'im_connected':
        return this.describeIMConnected(payload)
      case 'command_probe':
        return `命令探针 \`${payload.command}\`：${payload.reason}${payload.output ? `\n输出：${String(payload.output).substring(0, 500)}` : ''}`
      case 'http_probe':
        return `HTTP 探针 ${payload.method || 'GET'} ${payload.url}：${payload.reason}${payload.status != null ? ` (HTTP ${payload.status})` : ''}`
      case 'app_lifecycle':
        return this.describeAppLifecycle(payload)
      case 'milestone':
        return this.describeMilestone(payload)
      case 'watch_failure':
        return `关切「${payload.watchName}」执行失败：${payload.error}（耗时 ${Math.round((payload.duration as number) / 1000)}s）`
      default:
        return `${type}${payload.source ? ` 来自 ${payload.source}` : ''}`
    }
  }

  private static readonly IM_PLATFORM_NAMES: Record<string, string> = {
    dingtalk: '钉钉', feishu: '飞书', slack: 'Slack', telegram: 'Telegram', wecom: '企业微信'
  }

  private describeIMConnected(payload: Record<string, unknown>): string {
    const nameOf = (p: string) => WatchService.IM_PLATFORM_NAMES[p] || p
    const primary = typeof payload.platform === 'string' ? payload.platform : '未知'
    const all = Array.isArray(payload.platforms) ? payload.platforms.filter((p): p is string => typeof p === 'string') : []
    const userName = typeof payload.userName === 'string' ? payload.userName : undefined
    const userNote = userName ? `（最近联系人：${userName}）` : ''

    if (all.length > 1) {
      return `IM 上线：用户通过${nameOf(primary)}上线${userNote}（同时在线：${all.map(nameOf).join('、')}）`
    }
    return `IM 上线：用户通过${nameOf(primary)}上线${userNote}`
  }

  private describeAppLifecycle(payload: Record<string, unknown>): string {
    const event = payload.event as string
    const days = payload.daysTogether as number | undefined
    const convos = payload.totalConversations as number | undefined
    const statsNote = days != null ? `（已陪伴 ${days} 天，共 ${convos ?? 0} 次对话）` : ''
    switch (event) {
      case 'app_started': return `应用启动${statsNote}`
      case 'app_resumed': return '系统从睡眠/锁屏恢复'
      case 'app_idle': return `系统空闲（${payload.idleSeconds}秒）`
      case 'awakening_enabled': return '用户开启了觉醒模式'
      case 'awakening_disabled': return '用户关闭了觉醒模式'
      default: return `应用事件：${event}`
    }
  }

  private describeMilestone(payload: Record<string, unknown>): string {
    const mt = payload.milestoneType as string
    const value = payload.value as number
    switch (mt) {
      case 'days_together': return `里程碑：你们已经在一起 ${value} 天了！`
      case 'conversations': return `里程碑：累计完成了第 ${value} 次对话！`
      case 'anniversary': return `里程碑：${value} 周年纪念日！`
      default: return `里程碑：${mt} = ${value}`
    }
  }

  // ==================== 输出投递 ====================

  /** 唤醒 Agent 执行 ID（心跳/内心独白，保留跨执行工作记忆）；与 WAKEUP_AGENT_KEY 同源 */
  private static readonly WAKEUP_AGENT_ID = WAKEUP_AGENT_KEY
  /** 前端联络常驻 tab 的 agentId，与 AgentService.COMPANION_AGENT_ID 保持一致 */
  private static readonly COMPANION_AGENT_ID = '__companion__'

  /**
   * 关切执行失败：作为生命周期事件发射到 EventBus。
   * 唤醒 Watch 监听此事件并由 AI 自主决定如何通知用户，
   * 通知链路（主动消息 → IM → 系统通知）复用已有觉醒机制，无需重复实现。
   */
  private notifyFailure(watch: WatchDefinition, result: WatchExecutionResult): void {
    const errorMsg = result.error || '执行失败'
    log.warn(`Watch '${watch.name}' (${watch.id}) failed: ${errorMsg}`)

    try {
      getEventBus().emit({
        id: `watch-failure-${watch.id}-${Date.now().toString(36)}`,
        type: 'watch_failure',
        source: `watch:${watch.id}`,
        timestamp: Date.now(),
        payload: {
          watchId: watch.id,
          watchName: watch.name,
          error: errorMsg,
          duration: result.duration
        },
        priority: 'high'
      })
    } catch (err) {
      log.error('Failed to emit watch_failure event:', err)
    }
  }

  private isNoAction(output: string): boolean {
    const lastLine = output.trim().split('\n').pop()?.trim() ?? ''
    if (!lastLine) return false
    const normalized = lastLine.replace(/[.。\s]+$/u, '').toUpperCase()
    return normalized === 'NO_ACTION'
  }

  private async deliverOutput(watch: WatchDefinition, result: WatchExecutionResult, silent: boolean = false): Promise<void> {
    if (result.skipped) return

    const trimmedOutput = result.output?.trim() || ''
    if (!trimmedOutput && result.success) return
    if (this.isNoAction(trimmedOutput)) {
      log.info(`Agent decided NO_ACTION for: ${watch.name}`)
      return
    }

    const outputType = watch.output.type

    if (outputType === 'silent') return

    const windowAvailable = this.config?.mainWindow && !this.config.mainWindow.isDestroyed()

    // 唤醒 Watch：消息投递由 Agent 通过 talk_to_user 工具完成，此处不重复投递
    if (watch.id === WatchService.WAKEUP_ID) return

    // talk_to_user 已执行：messageUser 负责 IM + 应用内，此处不再派发
    if (result.userMessage) return

    // 静默执行（唤醒 / desktop 自动触发）：用户可见消息仅经 talk_to_user，框架不兜底通知
    if (silent) return

    // 以下仅处理非静默、且 Agent 未调用 talk_to_user 时的渠道兜底（如手动触发且应用不在前台）
    if (outputType === 'desktop') {
      if (!windowAvailable) {
        const imOk = await this.sendIMNotification(watch, result)
        if (!imOk) this.sendNotification(watch, result)
      }
      return
    }

    if (outputType === 'notification') {
      if (!windowAvailable) {
        const imOk = await this.sendIMNotification(watch, result)
        if (!imOk) this.sendNotification(watch, result)
      }
      return
    }

    // output.type === 'im'：未调 talk_to_user 即表示无需打扰用户，不发「已完成」类通知
  }

  /** 从 steps 提取 talk_to_user 正文，供 deliverOutput 判断 messageUser 是否已投递 */
  private extractUserMessage(steps?: AgentStep[]): string | undefined {
    if (!steps || steps.length === 0) return undefined
    const byCall = new Map<string, string>()
    for (const s of steps) {
      if (s.toolName !== 'talk_to_user' || !s.toolArgs) continue
      const msg = (s.toolArgs as Record<string, unknown>)?.message as string
      if (!msg) continue
      const key = s.toolCallId || s.id
      byCall.set(key, msg)
    }
    if (byCall.size === 0) return undefined
    return [...byCall.values()].join('\n')
  }

  /** 通知前端确保联络 tab 存在（Agent 执行前调用） */
  private ensureDesktopTab(): boolean {
    if (!this.config?.mainWindow || this.config.mainWindow.isDestroyed()) {
      return false
    }
    this.config.mainWindow.webContents.send('watch:ensureTab', {
      agentId: WatchService.COMPANION_AGENT_ID
    })
    return true
  }

  private sendNotification(watch: WatchDefinition, result: WatchExecutionResult): void {
    try {
      const title = result.success ? `✓ ${watch.name}` : `✗ ${watch.name}`
      const body = result.success
        ? (result.userMessage || `已完成 (${Math.round(result.duration / 1000)}s)`).substring(0, 200)
        : (result.error || 'Failed')

      const notification = new Notification({ title, body, silent: false })
      notification.once('click', () => {
        const mainWindow = this.config?.mainWindow
        if (!mainWindow || mainWindow.isDestroyed()) return
        mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
        if (process.platform === 'win32') {
          mainWindow.webContents.focus()
        }
        mainWindow.webContents.send('watch:activate-message', {
          agentId: WatchService.COMPANION_AGENT_ID,
        })
      })
      notification.show()
    } catch (err) {
      log.error('Failed to send notification:', err)
    }
  }

  /** 尝试通过 IM 发送通知，返回是否成功 */
  private async sendIMNotification(watch: WatchDefinition, result: WatchExecutionResult): Promise<boolean> {
    try {
      const imService = getIMService()

      const title = result.success ? `✓ ${watch.name}` : `✗ ${watch.name}`
      const message = result.success
        ? (result.userMessage || `已完成 (${Math.round(result.duration / 1000)}s)`).substring(0, 2000)
        : `Error: ${result.error || 'Unknown'}`

      const sendResult = await imService.sendNotification(`**${title}**\n\n${message}`, {
        markdown: true,
        title
      })
      return sendResult.success
    } catch (err) {
      log.error('Failed to send IM notification:', err)
      return false
    }
  }

  // ==================== 记录执行 ====================

  private recordExecution(watch: WatchDefinition, event: SensorEvent, result: WatchExecutionResult, agentSessionId?: string): void {
    let status: WatchRunStatus = 'completed'
    if (result.skipped) status = 'skipped'
    else if (!result.success) status = 'failed'

    const runRecord: WatchRunRecord = {
      at: Date.now(),
      status,
      duration: result.duration,
      triggerType: event.type,
      output: result.output.substring(0, MAX_OUTPUT_LENGTH),
      error: result.error,
      skipReason: result.skipReason,
      agentSessionId
    }

    this.store.updateLastRun(watch.id, runRecord)
    this.store.addHistory({
      watchId: watch.id,
      watchName: watch.name,
      ...runRecord
    })
  }

  // ==================== 定时调度 ====================

  private scheduleTimeTriggers(watch: WatchDefinition): void {
    for (const trigger of watch.triggers) {
      if (trigger.type === 'cron') {
        this.scheduleCron(watch.id, trigger.expression)
      } else if (trigger.type === 'interval') {
        this.scheduleInterval(watch.id, trigger.seconds)
      }
    }
  }

  private scheduleCron(watchId: string, expression: string): void {
    if (!CronExpressionParser) return

    const timerKey = `${watchId}:cron`
    this.cancelTimer(timerKey)

    try {
      const interval = CronExpressionParser.parse(expression)
      const nextRun = interval.next().getTime()
      const delay = nextRun - Date.now()

      if (delay <= 0) {
        this.emitTimerEvent(watchId, 'cron')
        return
      }

      this.store.updateNextRun(watchId, nextRun)

      this.setSafeTimer(timerKey, nextRun, () => {
        this.emitTimerEvent(watchId, 'cron')
        const watch = this.store.get(watchId)
        if (watch?.enabled && this.isRunning) {
          this.scheduleCron(watchId, expression)
        }
      })
    } catch (err) {
      log.error(`Failed to schedule cron for ${watchId}:`, err)
    }
  }

  private scheduleInterval(watchId: string, seconds: number): void {
    const timerKey = `${watchId}:interval`
    this.cancelTimer(timerKey)

    const ms = seconds * 1000
    const nextRun = Date.now() + ms
    this.store.updateNextRun(watchId, nextRun)

    this.setSafeTimer(timerKey, nextRun, () => {
      this.emitTimerEvent(watchId, 'interval')
      const watch = this.store.get(watchId)
      if (watch?.enabled && this.isRunning) {
        this.scheduleInterval(watchId, seconds)
      }
    })
  }

  /** setTimeout 安全封装：delay 超过 2^31-1 时分段等待，避免 Node.js TimeoutOverflowWarning */
  private setSafeTimer(timerKey: string, targetTime: number, callback: () => void): void {
    const delay = targetTime - Date.now()
    if (delay <= 0) {
      callback()
      return
    }
    const timer = setTimeout(() => {
      this.timers.delete(timerKey)
      if (delay > 0x7FFFFFFF) {
        this.setSafeTimer(timerKey, targetTime, callback)
      } else {
        callback()
      }
    }, Math.min(delay, 0x7FFFFFFF))
    this.timers.set(timerKey, timer)
  }

  private emitTimerEvent(watchId: string, type: 'cron' | 'interval'): void {
    const event: SensorEvent = {
      id: `${type}-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
      type,
      source: 'watch-service',
      timestamp: Date.now(),
      watchId,
      payload: {},
      priority: 'normal'
    }
    getEventBus().emit(event)
  }

  private cancelTimers(watchId: string): void {
    for (const [key, timer] of this.timers) {
      if (key.startsWith(`${watchId}:`)) {
        clearTimeout(timer)
        this.timers.delete(key)
      }
    }
    this.store.updateNextRun(watchId, undefined)
  }

  private cancelTimer(key: string): void {
    const timer = this.timers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(key)
    }
  }

  private checkMissedSchedules(): void {
    const watches = this.store.getAll()
    for (const watch of watches) {
      if (!watch.enabled) continue
      for (const trigger of watch.triggers) {
        if (trigger.type === 'cron') {
          const key = `${watch.id}:cron`
          if (!this.timers.has(key) && !this.runningWatches.has(watch.id) && !this.scheduledWatches.has(watch.id)) {
            this.scheduleCron(watch.id, trigger.expression)
          }
        } else if (trigger.type === 'interval') {
          const key = `${watch.id}:interval`
          if (!this.timers.has(key) && !this.runningWatches.has(watch.id) && !this.scheduledWatches.has(watch.id)) {
            this.scheduleInterval(watch.id, trigger.seconds)
          }
        }
      }
    }
  }

  // ==================== 状态管理 ====================

  // ==================== 传感器 target 管理 ====================

  private registerSensorTargets(watch: WatchDefinition): void {
    const sensor = this.config?.sensorService
    if (!sensor) return

    for (const trigger of watch.triggers) {
      try {
        if (trigger.type === 'file_change') {
          sensor.fileWatch.addTarget(watch.id, {
            paths: trigger.paths,
            pattern: trigger.pattern,
            events: trigger.events
          })
          if (!sensor.fileWatch.running && sensor.running) {
            sensor.fileWatch.start().catch(err =>
              log.error('Failed to start FileWatchSensor:', err)
            )
          }
        } else if (trigger.type === 'calendar') {
          sensor.calendar.addTarget(watch.id, {
            icsPath: trigger.icsPath,
            beforeMinutes: trigger.beforeMinutes
          })
          if (!sensor.calendar.running && sensor.running) {
            sensor.calendar.start().catch(err =>
              log.error('Failed to start CalendarSensor:', err)
            )
          }
        } else if (trigger.type === 'email') {
          sensor.email.addTarget(watch.id, trigger.filter)
          if (!sensor.email.running && sensor.running) {
            sensor.email.start().catch(err =>
              log.error('Failed to start EmailSensor:', err)
            )
          }
        } else if (trigger.type === 'command_probe') {
          sensor.commandProbe.addTarget(watch.id, {
            command: trigger.command,
            shell: trigger.shell,
            interval: trigger.interval,
            triggerOn: trigger.triggerOn,
            pattern: trigger.pattern,
            workingDirectory: trigger.workingDirectory,
          })
          if (!sensor.commandProbe.running && sensor.running) {
            sensor.commandProbe.start().catch(err =>
              log.error('Failed to start CommandProbeSensor:', err)
            )
          }
        } else if (trigger.type === 'http_probe') {
          sensor.httpProbe.addTarget(watch.id, {
            url: trigger.url,
            method: trigger.method,
            headers: trigger.headers,
            body: trigger.body,
            interval: trigger.interval,
            triggerOn: trigger.triggerOn,
            pattern: trigger.pattern,
            timeout: trigger.timeout,
          })
          if (!sensor.httpProbe.running && sensor.running) {
            sensor.httpProbe.start().catch(err =>
              log.error('Failed to start HttpProbeSensor:', err)
            )
          }
        }
      } catch (err) {
        log.error(`Failed to register sensor target for watch ${watch.id}:`, err)
      }
    }
  }

  private unregisterSensorTargets(watchId: string): void {
    const sensor = this.config?.sensorService
    if (!sensor) return

    sensor.fileWatch.removeTarget(watchId)
    sensor.calendar.removeTarget(watchId)
    sensor.email.removeTarget(watchId)
    sensor.commandProbe.removeTarget(watchId)
    sensor.httpProbe.removeTarget(watchId)
  }

  // ==================== 工具 ====================

  private notifyFrontend(channel: string, data: Record<string, unknown>): void {
    if (this.config?.mainWindow && !this.config.mainWindow.isDestroyed()) {
      this.config.mainWindow.webContents.send(channel, data)
    }
  }

  // ==================== 验证 ====================

  private validateParams(params: CreateWatchParams): void {
    if (!params.name?.trim()) {
      throw new Error('Watch name is required')
    }
    if (!params.prompt?.trim()) {
      throw new Error('Watch prompt is required')
    }
    if (!params.triggers || params.triggers.length === 0) {
      throw new Error('At least one trigger is required')
    }
    this.validateTriggers(params.triggers)
  }

  private validateTriggers(triggers: WatchTrigger[]): void {
    for (const trigger of triggers) {
      switch (trigger.type) {
        case 'cron':
          this.validateCronExpression(trigger.expression)
          break
        case 'interval':
          if (!trigger.seconds || trigger.seconds < MIN_INTERVAL_SECONDS) {
            throw new Error(`Interval must be at least ${MIN_INTERVAL_SECONDS} seconds`)
          }
          if (trigger.seconds > MAX_INTERVAL_SECONDS) {
            throw new Error(`Interval cannot exceed ${MAX_INTERVAL_SECONDS / 86400} days`)
          }
          break
        case 'heartbeat':
        case 'webhook':
        case 'manual':
        case 'im_connected':
        case 'app_lifecycle':
        case 'milestone':
        case 'watch_failure':
          break
        case 'file_change':
          if (!trigger.paths || trigger.paths.length === 0) {
            throw new Error('File change trigger requires at least one path')
          }
          break
        case 'calendar':
          if (typeof trigger.beforeMinutes !== 'number' || trigger.beforeMinutes < 1) {
            throw new Error('Calendar trigger requires beforeMinutes >= 1')
          }
          break
        case 'email':
          break
        case 'command_probe':
          if (!trigger.command?.trim()) {
            throw new Error('Command probe trigger requires a command')
          }
          if (!trigger.interval || trigger.interval < MIN_INTERVAL_SECONDS) {
            throw new Error(`Command probe interval must be at least ${MIN_INTERVAL_SECONDS} seconds`)
          }
          if (!['output_changed', 'regex_match', 'exit_code_nonzero'].includes(trigger.triggerOn)) {
            throw new Error(`Invalid command probe triggerOn: ${trigger.triggerOn}`)
          }
          if (trigger.triggerOn === 'regex_match' && !trigger.pattern?.trim()) {
            throw new Error('Command probe regex_match requires a pattern')
          }
          break
        case 'http_probe':
          if (!trigger.url?.trim()) {
            throw new Error('HTTP probe trigger requires a URL')
          }
          if (!trigger.interval || trigger.interval < MIN_INTERVAL_SECONDS) {
            throw new Error(`HTTP probe interval must be at least ${MIN_INTERVAL_SECONDS} seconds`)
          }
          if (!['status_changed', 'status_error', 'body_changed', 'regex_match'].includes(trigger.triggerOn)) {
            throw new Error(`Invalid HTTP probe triggerOn: ${trigger.triggerOn}`)
          }
          if (trigger.triggerOn === 'regex_match' && !trigger.pattern?.trim()) {
            throw new Error('HTTP probe regex_match requires a pattern')
          }
          break
        default:
          throw new Error(`Unknown trigger type: ${(trigger as any).type}`)
      }
    }
  }

  private validateCronExpression(expression: string): void {
    if (!expression?.trim()) {
      throw new Error('Cron expression is required')
    }
    if (!CronExpressionParser) {
      return // skip validation if parser not loaded (startup phase)
    }
    try {
      CronExpressionParser.parse(expression)
    } catch (e) {
      throw new Error(`Invalid cron expression "${expression}": ${(e as Error).message}`)
    }
  }

  private generateToken(): string {
    const crypto = require('crypto')
    return crypto.randomBytes(16).toString('base64url')
  }

  /** 更新 mainWindow 引用 */
  setMainWindow(win: BrowserWindow | null): void {
    if (this.config) {
      this.config.mainWindow = win
    }
  }

  // ==================== 觉醒模式 ====================

  private static readonly WAKEUP_ID = '__wakeup__'
  /** @deprecated 旧 ID，仅用于迁移清理 */
  private static readonly LEGACY_PATROL_ID = '__daily_patrol__'

  private static readonly HEARTBEAT_FILENAME = 'HEARTBEAT.md'

  /**
   * 默认心跳模板，包含 4 个模板变量：{{TIME}} / {{EVENTS}} / {{TODO}} / {{ACTIVITY}}。
   * 运行时由 resolveHeartbeatVariables() 替换为实际数据；删除变量则不注入对应信息。
   */
  static readonly DEFAULT_HEARTBEAT_TEMPLATE = `{{TIME}}
{{EVENTS}}
{{TODO}}
{{ACTIVITY}}

---

你刚被唤醒。用户看不到你的常规输出——只有通过 talk_to_user 发送的消息才能送达。

# 决策原则

沉默优先。有值得说的就调用 talk_to_user，没有就直接结束。

- 上次唤醒至今没有新事件，且间隔不到 6 小时——直接结束。偶尔可以简短打招呼，但不要每次都说。
- 23:00–07:00 是睡眠时段，除非紧急事件，不要打扰。你了解用户具体作息的，以实际习惯为准。
- 「一切正常」没有通知价值——沉默本身就代表正常。
- 对话历史中能看到你之前说过的话——没有新信息时，沉默比换角度重复更好。

# 事件响应

- **IM 上线**：根据时间、间隔、最近话题，自然地打招呼——问近况、分享发现、接着上次聊，每次换个角度。
- **应用启动**：根据时间和陪伴天数决定是否问好。
- **里程碑**：值得庆祝的时刻，真诚而有个性地表达。
- **待办到期**：根据创建日期和截止时间判断——短期任务临近截止时提醒，长期任务剩余约 1/3 时间时开始提醒，已逾期务必提醒。自然地在对话中提及，不要列清单。顺便清理已完成的条目。
- **用户近况**：活动摘要是你了解用户动态的窗口，怎么利用由你决定。
- **其他事件**：有通知价值就说，没有就结束。

# 风格

结合你的个性设定，像真人朋友一样自然交流。短句优先，一两句话即可。`

  private static readonly WAKEUP_TRIGGERS: WatchTrigger[] = [
    { type: 'heartbeat' },
    { type: 'im_connected' },
    { type: 'app_lifecycle' },
    { type: 'milestone' },
    { type: 'email' },
    { type: 'calendar' },
    { type: 'watch_failure' },
  ]

  /** 确保内置「唤醒」关切存在（觉醒模式开启时调用），幂等 */
  ensureWakeup(): boolean {
    try {
      // 清理旧版日常检查
      if (this.store.get(WatchService.LEGACY_PATROL_ID)) {
        try { this.cancelTimers(WatchService.LEGACY_PATROL_ID) } catch { /* ignore */ }
        try { this.unregisterSensorTargets(WatchService.LEGACY_PATROL_ID) } catch { /* ignore */ }
        this.store.delete(WatchService.LEGACY_PATROL_ID)
        log.info('旧版日常检查已清理')
      }

      this.ensureHeartbeatFile()

      const existing = this.store.get(WatchService.WAKEUP_ID)
      if (existing) {
        let needsUpdate = false

        if (existing.prompt?.includes('lastWakeDate')) {
          if (existing.state?.lastWakeDate) {
            const { lastWakeDate: _lastWakeDate, ...rest } = existing.state as Record<string, unknown>
            this.store.updateState(WatchService.WAKEUP_ID, rest)
          }
          needsUpdate = true
        } else if (!existing.prompt?.includes('# 决策原则')) {
          needsUpdate = true
        }

        const existingTypes = new Set((existing.triggers || []).map(t => t.type))
        const needsTriggerUpdate = WatchService.WAKEUP_TRIGGERS.some(t => !existingTypes.has(t.type))

        if (needsUpdate) {
          this.store.update(WatchService.WAKEUP_ID, {
            prompt: WatchService.DEFAULT_HEARTBEAT_TEMPLATE,
            triggers: WatchService.WAKEUP_TRIGGERS,
            updatedAt: Date.now()
          })
          log.info('唤醒关切已迁移（模板 + 触发器）')
        } else if (needsTriggerUpdate) {
          this.store.update(WatchService.WAKEUP_ID, {
            triggers: WatchService.WAKEUP_TRIGGERS,
            updatedAt: Date.now()
          })
          log.info('唤醒关切触发器已更新（新增 email/calendar）')
        }
        return true
      }

      const wakeup: WatchDefinition = {
        id: WatchService.WAKEUP_ID,
        name: '唤醒',
        description: '觉醒模式下的定时唤醒，AI 自主决定醒来后做什么',
        enabled: true,
        triggers: WatchService.WAKEUP_TRIGGERS,
        prompt: WatchService.DEFAULT_HEARTBEAT_TEMPLATE,
        execution: { type: 'local' },
        output: { type: 'desktop' },
        priority: 'normal',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }

      const created = this.store.createWithId(wakeup)
      if (!created) {
        log.warn('唤醒关切创建失败')
        return false
      }

      if (this.isRunning) {
        this.registerSensorTargets(wakeup)
      }
      log.info('唤醒关切已创建')
      return true
    } catch (e) {
      log.error('ensureWakeup 异常:', e)
      return false
    }
  }

  /** 确保 HEARTBEAT.md 存在，不存在则写入默认模板 */
  private ensureHeartbeatFile(): void {
    try {
      const workspace = getWorkspacePath()
      const filePath = path.join(workspace, WatchService.HEARTBEAT_FILENAME)
      if (fs.existsSync(filePath)) return
      fs.mkdirSync(workspace, { recursive: true })
      fs.writeFileSync(filePath, WatchService.DEFAULT_HEARTBEAT_TEMPLATE, 'utf-8')
      log.info('HEARTBEAT.md 已创建（默认模板）')
    } catch (e) {
      log.warn('创建 HEARTBEAT.md 失败:', e)
    }
  }

  /** 重置 HEARTBEAT.md 为默认模板（供 UI 调用） */
  resetHeartbeatFile(): boolean {
    try {
      const workspace = getWorkspacePath()
      fs.mkdirSync(workspace, { recursive: true })
      fs.writeFileSync(
        path.join(workspace, WatchService.HEARTBEAT_FILENAME),
        WatchService.DEFAULT_HEARTBEAT_TEMPLATE,
        'utf-8'
      )
      log.info('HEARTBEAT.md 已重置为默认模板')
      return true
    } catch (e) {
      log.warn('重置 HEARTBEAT.md 失败:', e)
      return false
    }
  }

  /** 移除内置「唤醒」关切（觉醒模式关闭时调用） */
  removeWakeup(): void {
    try {
      // 同时清理新旧两个 ID
      for (const id of [WatchService.WAKEUP_ID, WatchService.LEGACY_PATROL_ID]) {
        const existing = this.store.get(id)
        if (!existing) continue
        try { this.cancelTimers(id) } catch { /* ignore */ }
        try { this.unregisterSensorTargets(id) } catch { /* ignore */ }
        this.store.delete(id)
        log.info(`${id} 关切已移除`)
      }
    } catch (e) {
      log.error('removeWakeup 异常:', e)
    }
  }

  /**
   * 从旧版 Scheduler 迁移数据到 Watch 系统
   * 幂等操作：已迁移的任务（通过 name 匹配）不会重复创建
   * @param schedulerStore - 由调用方传入，避免在 bundle 环境中 require 失败
   */
  migrateFromScheduler(schedulerStore: { getTasks(): any[]; deleteTask(id: string): boolean } | null | undefined): { migrated: number; skipped: number; errors: string[] } {
    const result = { migrated: 0, skipped: 0, errors: [] as string[] }

    if (!schedulerStore) {
      result.errors.push('Scheduler store 不可用，跳过迁移')
      return result
    }

    try {
      const tasks = schedulerStore.getTasks()

      if (tasks.length === 0) return result

      const existingWatches = this.store.getAll()
      const existingNames = new Set(existingWatches.map((w: WatchDefinition) => w.name))

      for (const task of tasks) {
        try {
          if (existingNames.has(task.name)) {
            result.skipped++
            continue
          }

          const trigger = this.convertSchedulerTrigger(task.schedule)
          if (!trigger) {
            result.errors.push(`跳过 "${task.name}": 不支持的调度类型 ${task.schedule.type}`)
            continue
          }

          const execution: import('./types').WatchExecution = {
            type: task.target.type === 'ssh' ? 'ssh' : 'local',
            sshSessionId: task.target.sshSessionId,
            sshSessionName: task.target.sshSessionName,
            workingDirectory: task.target.workingDirectory,
            timeout: task.options?.timeout ?? 300
          }

          const params: CreateWatchParams = {
            name: task.name,
            description: task.description || `从定时任务迁移`,
            triggers: [trigger],
            prompt: task.prompt,
            execution,
            output: { type: task.options?.notifyOnComplete ? 'notification' : 'log' },
            priority: 'normal',
            enabled: task.enabled
          }

          this.create(params)
          result.migrated++
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          result.errors.push(`迁移 "${task.name}" 失败: ${msg}`)
        }
      }

      if (result.migrated > 0) {
        log.info(`已从 Scheduler 迁移 ${result.migrated} 个任务`)
      }

      // 迁移完成后清除旧 Scheduler 数据，防止两套系统并行运行
      if (result.migrated > 0 || result.skipped > 0) {
        try {
          const updatedNames = new Set(this.store.getAll().map((w: WatchDefinition) => w.name))
          let cleared = 0
          for (const task of tasks) {
            if (updatedNames.has(task.name)) {
              schedulerStore.deleteTask(task.id)
              cleared++
            }
          }
          if (cleared > 0) {
            log.info(`已清除 ${cleared} 个旧版 Scheduler 任务`)
          }
        } catch (cleanErr) {
          log.warn('清除旧 Scheduler 数据失败:', cleanErr)
        }
      }
    } catch (err) {
      result.errors.push(`迁移失败: ${err instanceof Error ? err.message : String(err)}`)
    }

    return result
  }

  private convertSchedulerTrigger(schedule: { type: string; expression: string }): WatchTrigger | null {
    switch (schedule.type) {
      case 'cron':
        return { type: 'cron', expression: schedule.expression }
      case 'interval': {
        const match = schedule.expression.match(/^(\d+)(s|m|h|d)$/)
        if (!match) return null
        const value = parseInt(match[1], 10)
        if (!Number.isSafeInteger(value) || value <= 0) return null
        const unitMap: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }
        return { type: 'interval', seconds: value * (unitMap[match[2]] || 60) }
      }
      case 'once':
        // once 类型的 expression 是 ISO 时间戳，转为 manual 触发（不适合 cron）
        return { type: 'manual' }
      default:
        return null
    }
  }
}

// 单例
let instance: WatchService | null = null

export function getWatchService(): WatchService {
  if (!instance) {
    instance = new WatchService()
  }
  return instance
}
