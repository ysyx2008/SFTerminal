/**
 * IM Service - 即时通讯平台集成服务
 *
 * 管理钉钉、飞书的连接，将 IM 消息路由到 Companion Agent。
 * IM 对话与觉醒唤醒、桌面助手共用同一个 Agent 会话，保持连贯上下文。
 *
 * 架构：
 *   IM 平台 ──→ Adapter ──→ IMService.handleMessage()
 *                                   │
 *                          AgentService.runAssistant(COMPANION_AGENT_ID)
 *                                   │
 *                          callbacks 聚合文本 ──→ Adapter.sendMarkdown()
 */

import type { ExecutionMode, RemoteChannel } from '@shared/types'
import { getDefaultShell, getLocalOS } from '../../utils/platform'
import { getEventBus } from '../sensor/event-bus'
import type {
  IMServiceConfig,
  IMAdapter,
  IMIncomingMessage,
  IMPlatform,
  IMAttachment,
  DingTalkConfig,
  FeishuConfig,
  SlackConfig,
  TelegramConfig,
  WeComConfig,
  WeChatConfig,
  SendFileResult
} from './types'
import { CONFIRM_KEYWORDS, REJECT_KEYWORDS, IM_TEXT_MAX_LENGTH } from './types'
import { DingTalkAdapter } from './dingtalk-adapter'
import { FeishuAdapter } from './feishu-adapter'
import { SlackAdapter } from './slack-adapter'
import { TelegramAdapter } from './telegram-adapter'
import { WeComAdapter } from './wecom-adapter'
import { WeChatAdapter } from './wechat-adapter'
import { AgentService } from '../agent'
import { getConfigService } from '../config.service'
import { t } from '../agent/i18n'
import { createLogger } from '../../utils/logger'
import path from 'path'
import fs from 'fs'

const log = createLogger('IMService')

export interface IMServiceDependencies {
  agentService: import('../agent').AgentService
  mainWindow: {
    webContents: {
      send: (channel: string, ...args: any[]) => void
      isDestroyed: () => boolean
    }
  } | null
}

export interface IMServiceStatus {
  dingtalk: {
    enabled: boolean
    connected: boolean
  }
  feishu: {
    enabled: boolean
    connected: boolean
  }
  slack: {
    enabled: boolean
    connected: boolean
  }
  telegram: {
    enabled: boolean
    connected: boolean
  }
  wecom: {
    enabled: boolean
    connected: boolean
  }
  wechat: {
    enabled: boolean
    connected: boolean
  }
}

/** 最近一次 IM 联系的上下文，用于主动推送 */
export interface IMLastContact {
  platform: IMPlatform
  replyContext: any
  userId: string
  userName: string
  chatId?: string
  chatType: 'single' | 'group'
  updatedAt: number
}

/** 工具 → 图标 */
const TOOL_ICONS: Record<string, string> = {
  execute_command: '🔧', exec: '🔧', dispatch_agents: '🔀', read_file: '📄', edit_file: '✏️',
  write_text_file: '📝', write_remote_text_file: '📝', file_search: '🔍',
  search_knowledge: '📚', get_knowledge_doc: '📚',
  recall: '🧠', recall_task: '🧠', deep_recall: '🧠', wait: '⏳',
  plan: '📋', create_plan: '📋', update_plan: '📋', clear_plan: '📋',
  send_to_chat: '📤', send_file_to_chat: '📤', send_image_to_chat: '🖼️', send_im_notification: '📢',
  remember_info: '💾', check_terminal_status: '🖥️', get_terminal_context: '🖥️',
  send_control_key: '⌨️', send_input: '⌨️', skill: '📦', load_skill: '📦', load_user_skill: '📦',
}

/** 工具 → 已有 i18n key 的映射（复用已有翻译，避免重复添加） */
const TOOL_I18N_MAP: Record<string, Parameters<typeof t>[0]> = {
  execute_command: 'tool.execute_command',
  exec: 'tool.execute_command',
  check_terminal_status: 'tool.check_terminal_status',
  get_terminal_context: 'tool.get_terminal_context',
  send_control_key: 'tool.send_control_key',
  send_input: 'tool.send_input',
  read_file: 'tool.read_file',
  edit_file: 'file.edit',
  write_text_file: 'tool.write_file',
  write_remote_text_file: 'tool.write_file',
  file_search: 'file.searching',
  remember_info: 'tool.remember_info',
  search_knowledge: 'tool.search_knowledge',
  get_knowledge_doc: 'tool.get_knowledge_doc',
  recall: 'memory.task_recall',
  recall_task: 'memory.task_recall',
  deep_recall: 'memory.deep_recall',
  wait: 'tool.wait',
  plan: 'tool.plan',
  create_plan: 'tool.create_plan',
  update_plan: 'tool.update_plan',
  clear_plan: 'tool.clear_plan',
  skill: 'tool.skill',
  ask_user: 'tool.ask_user',
  dispatch_agents: 'tool.dispatch_agents',
  send_file_to_chat: 'im.tool_sending_file',
  send_image_to_chat: 'im.tool_sending_image',
  send_to_chat: 'im.tool_sending_file',
}

/** 截断过长文本，附加省略号 */
function truncate(text: string, maxLen = 100): string {
  if (!text) return ''
  return text.length > maxLen ? text.substring(0, maxLen) + '...' : text
}

/**
 * 将工具调用格式化为用户友好的通知文本
 * 通过映射复用 i18n 已有翻译，无匹配时 fallback 到 toolName
 */
function formatToolNotification(toolName: string, toolArgs?: Record<string, unknown>): string {
  const icon = TOOL_ICONS[toolName] || '🔧'
  const i18nKey = TOOL_I18N_MAP[toolName]
  const args = toolArgs || {}

  // 文件发送工具：直接传文件名和大小参数渲染 label
  if (
    (toolName === 'send_file_to_chat' || toolName === 'send_image_to_chat' || toolName === 'send_to_chat') &&
    i18nKey &&
    (args.file_name || args.file_path)
  ) {
    const filePath = args.file_path ? String(args.file_path) : ''
    const name = args.file_name ? String(args.file_name) : path.basename(filePath)
    let size = ''
    try {
      if (filePath) {
        const bytes = fs.statSync(filePath).size
        if (bytes < 1024) size = ` (${bytes} B)`
        else if (bytes < 1024 * 1024) size = ` (${(bytes / 1024).toFixed(1)} KB)`
        else size = ` (${(bytes / 1024 / 1024).toFixed(2)} MB)`
      }
    } catch {
      // 文件不存在或无权限，忽略大小
    }
    return `${t(i18nKey, { name: truncate(name), size })}`
  }

  const label = i18nKey ? t(i18nKey) : toolName

  // 根据工具类型附加关键参数
  let detail = ''
  if (toolName === 'execute_command' || toolName === 'exec') {
    const cmd = args.command ? String(args.command) : ''
    detail = cmd ? `\n$ ${cmd.length > 200 ? cmd.substring(0, 200) + '...' : cmd}` : ''
  } else if (toolName === 'file_search') {
    const q = args.pattern ?? args.query
    const parts: string[] = []
    if (q != null && String(q).trim() !== '') parts.push(`query: ${truncate(String(q))}`)
    if (args.path != null && String(args.path).trim() !== '') parts.push(`path: ${truncate(String(args.path))}`)
    if (args.type != null && args.type !== 'all') parts.push(`type: ${String(args.type)}`)
    if (args.limit != null && Number(args.limit) !== 50) parts.push(`limit: ${String(args.limit)}`)
    if (parts.length > 0) detail = `  ${parts.join(' · ')}`
  } else if (toolName === 'send_control_key' && args.key) {
    detail = ` ${args.key}`
  } else if (toolName === 'wait' && args.seconds) {
    detail = ` ${args.seconds}s`
  } else if (toolName === 'dispatch_agents' && Array.isArray(args.tasks)) {
    detail = ` ${(args.tasks as Array<unknown>).length} 个子任务`
  } else if (toolName === 'skill' || toolName === 'load_skill' || toolName === 'load_user_skill') {
    const id = args.skill_id || args.name
    if (id) detail = `  ${id}`
  } else if (toolName === 'web_search') {
    const parts: string[] = []
    if (args.query != null && String(args.query).trim() !== '') {
      parts.push(`query: ${truncate(String(args.query))}`)
    }
    if (args.max_results != null && Number(args.max_results) !== 5) {
      parts.push(`max_results: ${String(args.max_results)}`)
    }
    if (parts.length > 0) detail = `  ${parts.join(' · ')}`
  } else if (toolName === 'search_knowledge' && args.query) {
    // 知识库搜索本身带完整 toolArgs，沿用仅展示关键词的简洁样式
    detail = `  ${truncate(String(args.query))}`
  } else if (toolName === 'search_history' && args.keyword) {
    detail = `  ${truncate(String(args.keyword))}`
  } else if (toolName === 'web_fetch' && args.url) {
    detail = `  ${truncate(String(args.url))}`
  } else if (toolName === 'send_input' && args.text) {
    detail = `  ${truncate(String(args.text))}`
  } else if (toolName === 'remember_info' && args.info) {
    detail = `  ${truncate(String(args.info))}`
  } else if (toolName === 'ask_user' && args.question) {
    detail = `  ${truncate(String(args.question))}`
  } else if (toolName === 'talk_to_user') {
    const msg = args.msg || args.message || args.text
    if (msg) detail = `  ${truncate(String(msg))}`
  } else if (toolName === 'send_to_chat' && args.file_path) {
    detail = `  ${truncate(String(args.file_path))}`
  } else if (toolName === 'recall' && args.task_id) {
    detail = `  ${truncate(String(args.task_id))}`
  } else if (toolName === 'get_knowledge_doc' && args.doc_id) {
    detail = `  ${truncate(String(args.doc_id))}`
  } else if (toolName === 'plan' && args.title) {
    detail = `  ${truncate(String(args.title))}`
  } else if (toolName.startsWith('calendar_') || toolName.startsWith('todo_')) {
    const action = toolName.split('_').slice(1).join('_')
    const parts: string[] = []
    if (action) parts.push(action)
    if (args.title) parts.push(truncate(String(args.title)))
    if (parts.length > 0) detail = `  ${parts.join(' · ')}`
  } else if (toolName === 'wecom_read' || toolName === 'wecom_write') {
    const action = toolName === 'wecom_read' ? 'read' : 'write'
    const parts: string[] = [action]
    if (args.resource) parts.push(truncate(String(args.resource)))
    detail = `  ${parts.join(' · ')}`
  } else if (args.path) {
    // read_file / edit_file / write_text_file 等通用 path 参数兜底
    detail = `  ${truncate(String(args.path))}`
  }

  return `${icon} ${label}${detail}`
}

/** 向 IM 用户投递文件/图片的工具；失败时必须推送到聊天，不能只在桌面面板可见 */
export const IM_DELIVERY_TOOL_NAMES = new Set([
  'send_file_to_chat',
  'send_image_to_chat',
  'send_to_chat',
])

/** 是否为 IM 投递类工具的失败结果（需同步到微信等渠道） */
export function isImDeliveryToolFailure(step: {
  toolName?: string
  success?: boolean
  content?: string
}): boolean {
  if (!step.toolName || !IM_DELIVERY_TOOL_NAMES.has(step.toolName)) return false
  if (step.success === false) return true
  return !!step.content?.includes('❌')
}

/** 格式化 IM 投递失败通知（优先复用工具已生成的 i18n 文案） */
export function formatImDeliveryToolFailure(step: {
  content?: string
  toolName?: string
  toolResult?: string
}): string {
  const text = step.content?.trim()
  if (text) return text
  const detail = step.toolResult?.trim()
  if (detail) return `❌ ${step.toolName}: ${detail}`
  return `❌ ${step.toolName ?? 'send'}`
}

/**
 * 格式化通用工具失败通知（区别于 IM 投递失败）。
 *
 * 微信侧用户原本只能看到「🔧 调用 calendar_list…」一条 tool_call 通知，看不出
 * 工具最终成败；同名工具反复失败时手机端表现为"重复刷同一句"，体感诡异。
 * 失败时补一条「❌ xxx：原因」让用户能区分。成功的工具不发"✅"提示，避免
 * 短时间内出站消息密度过高（微信会触发 errcode=-2）。
 *
 * reason 取 toolResult / content 的第一行，并剥掉首端已有的红/警告 emoji，
 * 防止"❌ xxx：❌ ..."的重复。
 */
export function formatToolFailureNotification(step: {
  toolName?: string
  toolResult?: string
  content?: string
}): string {
  const toolName = step.toolName ?? '工具'
  const i18nKey = TOOL_I18N_MAP[toolName]
  const label = i18nKey ? t(i18nKey) : toolName
  const raw = (step.toolResult || step.content || '').trim()
  const firstLine = raw.split('\n')[0]?.replace(/^[\u274c\u26a0\ufe0f\ud83d\udeab]+\s*/u, '').trim() ?? ''
  const detail = firstLine ? `：${truncate(firstLine, 120)}` : ''
  return `❌ ${label} 失败${detail}`
}

/** 进程通知去重键：同工具+同 path 只通知一次（避免分段 write 刷屏） */
function toolProcessNotifyKey(
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
  stepId?: string,
): string {
  const args = toolArgs || {}
  const pathVal = args.path ?? args.file_path
  if (pathVal != null && String(pathVal).trim() !== '') {
    return `${toolName}:${String(pathVal)}`
  }
  return stepId || `${toolName}:${JSON.stringify(args)}`
}

/**
 * 把 AI 输出拆成 thinking（思考过程）和 body（正文）两部分，去掉所有 <details>/<blockquote> 标签。
 *
 * IM 渠道默认只发 body：
 *  - 中间轮的「好的，帮你记上日程」这种正文会被发出去
 *  - reasoning 模型的「思考过程」卡片不会刷屏
 *
 * 但保留 thinking 文本，在 onComplete 时如果整个会话都没发过任何实质正文，
 * 把最近一次 thinking 当作兜底发给用户，避免「AI 没回复」的空洞结果。
 *
 * 兼容流式中途 flush（<details>/<blockquote> 可能未闭合）。
 */
function splitThinkingAndBody(content: string): { thinking: string; body: string } {
  const normalized = content.replace(/\r\n/g, '\n')
  let thinking = ''
  let body = normalized

  // 1) 完整 <details>...</details>：抽取 blockquote 内文，原位删除整块
  body = body.replace(
    /<details\b[^>]*>\s*<summary\b[^>]*>[\s\S]*?<\/summary>\s*<blockquote\b[^>]*>\s*([\s\S]*?)\s*<\/blockquote>\s*<\/details>/g,
    (_m, captured: string) => {
      const cleaned = captured.replace(/<[^>]+>/g, '').trim()
      if (cleaned) thinking = cleaned
      return ''
    }
  )

  // 2) 未闭合的 <details>（流式中途）：抽取已收到的部分，从尾部删除
  body = body.replace(
    /<details\b[^>]*>\s*<summary\b[^>]*>[\s\S]*?<\/summary>\s*(?:<blockquote\b[^>]*>\s*)?([\s\S]*)$/,
    (_m, captured: string) => {
      const cleaned = captured.replace(/<\/?(blockquote|details)\b[^>]*>/g, '').replace(/<[^>]+>/g, '').trim()
      if (cleaned) thinking = cleaned
      return ''
    }
  )

  return { thinking: thinking.trim(), body: body.trim() }
}

/** 把思考过程文本格式化为 IM markdown（标题 + 引用块） */
function formatThinkingForIM(thinking: string): string {
  const quoted = thinking.split('\n').map((l) => `> ${l}`).join('\n')
  return `**🤔 ${t('ai.thinking_process')}**\n\n${quoted}`
}

// ==================== 文件传输任务 ====================

export interface FileTransferTask {
  taskId: string
  displayName: string
  status: 'uploading' | 'done' | 'failed'
  error?: string
  startedAt: number
  finishedAt?: number
  /** 内部：等待完成的挂起回调 */
  _waiters: Array<(status: 'done' | 'failed') => void>
}

/** 完成后在内存中保留任务状态的时长（让 Agent 还能查到结果） */
const FILE_TRANSFER_KEEP_MS = 5 * 60 * 1000 // 5 分钟

export class IMService {
  private static readonly CONTACT_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

  private deps: IMServiceDependencies | null = null
  private dingtalkAdapter: DingTalkAdapter | null = null
  private feishuAdapter: FeishuAdapter | null = null
  private slackAdapter: SlackAdapter | null = null
  private telegramAdapter: TelegramAdapter | null = null
  private wecomAdapter: WeComAdapter | null = null
  private wechatAdapter: WeChatAdapter | null = null
  private config: IMServiceConfig = {
    dingtalk: { enabled: false, clientId: '', clientSecret: '' },
    feishu: { enabled: false, appId: '', appSecret: '' },
    slack: { enabled: false, botToken: '', appToken: '' },
    telegram: { enabled: false, botToken: '' },
    wecom: { enabled: false, botId: '', secret: '' },
    wechat: { enabled: false, token: '', baseUrl: '' },
    executionMode: 'relaxed',
    sessionTimeoutMinutes: 60,
    sendProcessMessages: true,
    sendThinkingProcess: false,
  }

  /** 当前活跃的 IM 会话上下文（Agent 运行期间有效） */
  private activeSession: { adapter: IMAdapter; replyContext: any } | null = null

  /** 最近一次联系 AI 的 IM 渠道上下文（用于主动推送） */
  private lastContact: IMLastContact | null = null
  /** 各平台最近一次联系记录（持久化） */
  private contactsByPlatform: Partial<Record<IMPlatform, IMLastContact>> = {}
  /** 已知用户集合（platform:userId），用于精确判断首次联系（持久化） */
  private knownUsers = new Set<string>()
  /** 本次运行期间已发送过 im_connected 事件的平台（避免重连时重复触发） */
  private emittedConnectPlatforms = new Set<IMPlatform>()
  /** 异步文件传输任务表（task_id → 任务状态） */
  private fileTransferTasks = new Map<string, FileTransferTask>()
  private fileTransferNextId = 1
  /** 防抖：多个平台短时间内连接时合并为一个 im_connected 事件 */
  private pendingConnectPlatforms = new Set<IMPlatform>()
  private connectDebounceTimer: NodeJS.Timeout | null = null
  private static readonly CONNECT_DEBOUNCE_MS = 3000
  /** 插件注册的额外 adapter（运行时动态添加） */
  private pluginAdapters = new Map<string, IMAdapter>()

  constructor() {
    this.loadPersistedContacts()
    this.lastContact = this.pickMostRecentContact(this.contactsByPlatform)
  }

  /**
   * 注入依赖
   */
  setDependencies(deps: IMServiceDependencies) {
    this.deps = deps
  }

  /**
   * 更新 mainWindow 引用
   */
  setMainWindow(win: IMServiceDependencies['mainWindow']) {
    if (this.deps) {
      this.deps.mainWindow = win
    }
  }

  /**
   * 设置 Agent 执行模式
   */
  setExecutionMode(mode: ExecutionMode) {
    this.config.executionMode = mode
  }

  /**
   * 设置是否发送过程消息
   */
  setSendProcessMessages(enabled: boolean) {
    this.config.sendProcessMessages = enabled
  }

  /**
   * 设置是否发送 AI 思考过程
   */
  setSendThinkingProcess(enabled: boolean) {
    this.config.sendThinkingProcess = enabled
  }

  // ==================== IM 生命周期事件 ====================

  /**
   * 平台连接成功后，收集到防抖窗口中。
   * 多个平台短时间内连接时（如应用启动），合并为一个 im_connected 事件，
   * 以最近联系的平台为主，避免 Watch 串行处理导致选错平台。
   */
  private emitConnectedEvent(platform: IMPlatform): void {
    if (this.emittedConnectPlatforms.has(platform)) return
    const contact = this.contactsByPlatform[platform]
    if (!contact || this.isContactExpired(contact)) return

    this.emittedConnectPlatforms.add(platform)
    this.pendingConnectPlatforms.add(platform)

    if (this.connectDebounceTimer) clearTimeout(this.connectDebounceTimer)
    this.connectDebounceTimer = setTimeout(() => this.flushConnectedEvent(), IMService.CONNECT_DEBOUNCE_MS)
  }

  /** 防抖窗口结束后，发送合并的 im_connected 事件 */
  private flushConnectedEvent(): void {
    this.connectDebounceTimer = null
    const platforms = Array.from(this.pendingConnectPlatforms)
    this.pendingConnectPlatforms.clear()
    if (platforms.length === 0) return

    // 选取最近联系的平台作为主平台（最可能是用户当前使用的）
    const primary = this.pickMostRecentPlatform(platforms)
    const contact = this.contactsByPlatform[primary]
    if (!contact) return

    try {
      const eventBus = getEventBus()
      eventBus.emit({
        id: `im-conn-${primary}-${Date.now().toString(36)}`,
        type: 'im_connected',
        source: `im:${primary}`,
        timestamp: Date.now(),
        payload: {
          platform: primary,
          platforms,
          userName: contact.userName,
          userId: contact.userId,
          chatType: contact.chatType,
        },
        priority: 'normal'
      })
      log.info(`Emitted im_connected event: primary=${primary}, all=[${platforms.join(',')}]`)
    } catch (err) {
      log.warn(`Failed to emit im_connected event:`, err)
    }
  }

  /** 从候选平台中选取最近联系过的那个 */
  private pickMostRecentPlatform(platforms: IMPlatform[]): IMPlatform {
    let best = platforms[0]
    let bestTime = 0
    for (const p of platforms) {
      const c = this.contactsByPlatform[p]
      if (c && c.updatedAt > bestTime) {
        bestTime = c.updatedAt
        best = p
      }
    }
    return best
  }

  private handleConnectionChange(platform: IMPlatform, connected: boolean): void {
    this.sendToDesktop('im:connectionChange', { platform, connected })
    if (connected) this.emitConnectedEvent(platform)
  }

  // ==================== 钉钉管理 ====================

  async startDingTalk(config: DingTalkConfig): Promise<{ success: boolean; error?: string }> {
    if (!config.clientId || !config.clientSecret) {
      return { success: false, error: 'ClientID and ClientSecret are required' }
    }

    try {
      await this.stopDingTalk()

      this.config.dingtalk = { ...config, enabled: true }
      this.dingtalkAdapter = new DingTalkAdapter(config)

      this.dingtalkAdapter.onMessage = (msg) => this.handleIncomingMessage(msg)
      this.dingtalkAdapter.onConnectionChange = (connected) =>
        this.handleConnectionChange('dingtalk', connected)

      await this.dingtalkAdapter.start()
      log.info('DingTalk started')
      return { success: true }
    } catch (err: any) {
      log.error('DingTalk start failed:', err)
      this.dingtalkAdapter = null
      return { success: false, error: err.message || 'Failed to connect' }
    }
  }

  async stopDingTalk(): Promise<void> {
    if (this.dingtalkAdapter) {
      await this.dingtalkAdapter.stop()
      this.dingtalkAdapter = null
      this.config.dingtalk.enabled = false
      log.info('DingTalk stopped')
    }
  }

  isDingTalkConnected(): boolean {
    return this.dingtalkAdapter?.isConnected() ?? false
  }

  // ==================== 飞书管理 ====================

  async startFeishu(config: FeishuConfig): Promise<{ success: boolean; error?: string }> {
    if (!config.appId || !config.appSecret) {
      return { success: false, error: 'App ID and App Secret are required' }
    }

    try {
      await this.stopFeishu()

      this.config.feishu = { ...config, enabled: true }
      this.feishuAdapter = new FeishuAdapter(config)

      this.feishuAdapter.onMessage = (msg) => this.handleIncomingMessage(msg)
      this.feishuAdapter.onConnectionChange = (connected) =>
        this.handleConnectionChange('feishu', connected)

      await this.feishuAdapter.start()
      log.info('Feishu started')
      return { success: true }
    } catch (err: any) {
      log.error('Feishu start failed:', err)
      this.feishuAdapter = null
      return { success: false, error: err.message || 'Failed to connect' }
    }
  }

  async stopFeishu(): Promise<void> {
    if (this.feishuAdapter) {
      await this.feishuAdapter.stop()
      this.feishuAdapter = null
      this.config.feishu.enabled = false
      log.info('Feishu stopped')
    }
  }

  isFeishuConnected(): boolean {
    return this.feishuAdapter?.isConnected() ?? false
  }

  // ==================== Slack 管理 ====================

  async startSlack(config: SlackConfig): Promise<{ success: boolean; error?: string }> {
    if (!config.botToken || !config.appToken) {
      return { success: false, error: 'Bot Token and App Token are required' }
    }
    if (!config.botToken.startsWith('xoxb-')) {
      return { success: false, error: 'Invalid Bot Token format (must start with xoxb-)' }
    }
    if (!config.appToken.startsWith('xapp-')) {
      return { success: false, error: 'Invalid App Token format (must start with xapp-)' }
    }

    try {
      await this.stopSlack()

      this.config.slack = { ...config, enabled: true }
      this.slackAdapter = new SlackAdapter(config)

      this.slackAdapter.onMessage = (msg: IMIncomingMessage) => this.handleIncomingMessage(msg)
      this.slackAdapter.onConnectionChange = (connected: boolean) =>
        this.handleConnectionChange('slack', connected)

      await this.slackAdapter.start()
      log.info('Slack started')
      return { success: true }
    } catch (err: any) {
      log.error('Slack start failed:', err)
      this.slackAdapter = null
      return { success: false, error: err.message || 'Failed to connect' }
    }
  }

  async stopSlack(): Promise<void> {
    if (this.slackAdapter) {
      await this.slackAdapter.stop()
      this.slackAdapter = null
      this.config.slack.enabled = false
      log.info('Slack stopped')
    }
  }

  isSlackConnected(): boolean {
    return this.slackAdapter?.isConnected() ?? false
  }

  // ==================== Telegram 管理 ====================

  async startTelegram(config: TelegramConfig): Promise<{ success: boolean; error?: string }> {
    if (!config.botToken) {
      return { success: false, error: 'Bot Token is required' }
    }
    if (!/^\d+:.+$/.test(config.botToken)) {
      return { success: false, error: 'Invalid Bot Token format (expected: 123456:ABC-DEF...)' }
    }

    try {
      await this.stopTelegram()

      this.config.telegram = { ...config, enabled: true }
      this.telegramAdapter = new TelegramAdapter(config)

      this.telegramAdapter.onMessage = (msg: IMIncomingMessage) => this.handleIncomingMessage(msg)
      this.telegramAdapter.onConnectionChange = (connected: boolean) =>
        this.handleConnectionChange('telegram', connected)

      await this.telegramAdapter.start()
      log.info('Telegram started')
      return { success: true }
    } catch (err: any) {
      log.error('Telegram start failed:', err)
      this.telegramAdapter = null
      return { success: false, error: err.message || 'Failed to connect' }
    }
  }

  async stopTelegram(): Promise<void> {
    if (this.telegramAdapter) {
      await this.telegramAdapter.stop()
      this.telegramAdapter = null
      this.config.telegram.enabled = false
      log.info('Telegram stopped')
    }
  }

  isTelegramConnected(): boolean {
    return this.telegramAdapter?.isConnected() ?? false
  }

  // ==================== 企业微信管理 ====================

  async startWeCom(config: WeComConfig): Promise<{ success: boolean; error?: string }> {
    if (!config.botId || !config.secret) {
      return { success: false, error: 'Bot ID and Secret are required' }
    }

    try {
      await this.stopWeCom()

      this.config.wecom = { ...config, enabled: true }
      this.wecomAdapter = new WeComAdapter(config)

      this.wecomAdapter.onMessage = (msg: IMIncomingMessage) => this.handleIncomingMessage(msg)
      this.wecomAdapter.onConnectionChange = (connected: boolean) =>
        this.handleConnectionChange('wecom', connected)

      await this.wecomAdapter.start()
      log.info('WeCom started')
      return { success: true }
    } catch (err: any) {
      log.error('WeCom start failed:', err)
      this.wecomAdapter = null
      return { success: false, error: err.message || 'Failed to connect' }
    }
  }

  async stopWeCom(): Promise<void> {
    if (this.wecomAdapter) {
      await this.wecomAdapter.stop()
      this.wecomAdapter = null
      this.config.wecom.enabled = false
      log.info('WeCom stopped')
    }
  }

  isWeComConnected(): boolean {
    return this.wecomAdapter?.isConnected() ?? false
  }

  // ==================== 微信管理 ====================

  /**
   * 发起微信扫码登录。返回 QR 码 URL（前端展示用）。
   * 登录成功后内部自动启动长轮询，并通过 onConnectionChange 通知前端。
   * @param onCredentials 登录成功后的回调，外部可用来持久化 token/baseUrl
   */
  async loginWeChat(
    onCredentials?: (creds: { token: string; baseUrl: string }) => void
  ): Promise<{ success: boolean; qrcodeUrl?: string; error?: string }> {
    try {
      await this.stopWeChat()

      this.wechatAdapter = new WeChatAdapter({ enabled: true, token: '', baseUrl: '' })
      this.wechatAdapter.onMessage = (msg: IMIncomingMessage) => this.handleIncomingMessage(msg)
      this.wechatAdapter.onConnectionChange = (connected: boolean) => {
        this.handleConnectionChange('wechat', connected)
        if (connected && onCredentials) {
          const creds = this.wechatAdapter!.getCredentials()
          this.config.wechat = { enabled: true, ...creds }
          onCredentials(creds)
        }
      }

      const result = await this.wechatAdapter.login()
      log.info('WeChat QR login initiated')
      return { success: true, qrcodeUrl: result.qrcodeUrl }
    } catch (err: any) {
      log.error('WeChat login failed:', err)
      this.wechatAdapter = null
      return { success: false, error: err.message || 'Failed to start login' }
    }
  }

  /**
   * 使用已保存的凭证启动微信连接（用于自动连接）
   */
  async startWeChat(config: WeChatConfig): Promise<{ success: boolean; error?: string }> {
    if (!config.token) {
      return { success: false, error: 'Token is required (please login via QR first)' }
    }

    try {
      await this.stopWeChat()

      this.config.wechat = { ...config, enabled: true }
      this.wechatAdapter = new WeChatAdapter(config)

      this.wechatAdapter.onMessage = (msg: IMIncomingMessage) => this.handleIncomingMessage(msg)
      this.wechatAdapter.onConnectionChange = (connected: boolean) =>
        this.handleConnectionChange('wechat', connected)

      await this.wechatAdapter.start()
      log.info('WeChat started with saved token')
      return { success: true }
    } catch (err: any) {
      log.error('WeChat start failed:', err)
      this.wechatAdapter = null
      return { success: false, error: err.message || 'Failed to connect' }
    }
  }

  async stopWeChat(): Promise<void> {
    if (this.wechatAdapter) {
      await this.wechatAdapter.stop()
      this.wechatAdapter = null
      this.config.wechat.enabled = false
      log.info('WeChat stopped')
    }
  }

  isWeChatConnected(): boolean {
    return this.wechatAdapter?.isConnected() ?? false
  }

  // ==================== 全局操作 ====================

  async stopAll(): Promise<void> {
    if (this.connectDebounceTimer) {
      clearTimeout(this.connectDebounceTimer)
      this.connectDebounceTimer = null
    }
    await this.stopDingTalk()
    await this.stopFeishu()
    await this.stopSlack()
    await this.stopTelegram()
    await this.stopWeCom()
    await this.stopWeChat()
  }

  getStatus(): IMServiceStatus {
    return {
      dingtalk: {
        enabled: this.config.dingtalk.enabled,
        connected: this.isDingTalkConnected(),
      },
      feishu: {
        enabled: this.config.feishu.enabled,
        connected: this.isFeishuConnected(),
      },
      slack: {
        enabled: this.config.slack.enabled,
        connected: this.isSlackConnected(),
      },
      telegram: {
        enabled: this.config.telegram.enabled,
        connected: this.isTelegramConnected(),
      },
      wecom: {
        enabled: this.config.wecom.enabled,
        connected: this.isWeComConnected(),
      },
      wechat: {
        enabled: this.config.wechat.enabled,
        connected: this.isWeChatConnected(),
      }
    }
  }

  // ==================== 主动推送 ====================

  /**
   * 获取最近联系 AI 的 IM 渠道信息
   */
  getLastContact(): IMLastContact | null {
    return this.lastContact
  }

  /**
   * 主动向最近联系 AI 的 IM 渠道发送通知消息
   *
   * @param text   消息内容
   * @param options.markdown  是否以 Markdown 格式发送（默认 false）
   * @param options.title     Markdown 模式下的标题（默认 '通知'）
   */
  async sendNotification(
    text: string,
    options?: { markdown?: boolean; title?: string }
  ): Promise<{
    success: boolean
    platform?: IMPlatform
    error?: string
    failedPlatforms?: { platform: string; error: string }[]
  }> {
    if (!text || typeof text !== 'string') {
      return { success: false, error: t('im.notification_empty') }
    }

    const targets = this.getNotificationTargets()
    if (targets.length === 0) {
      return { success: false, error: t('im.notification_no_contact') }
    }

    // 截断过长文本（adapter 内部也有截断，此处做防御性限制）
    const truncated = text.length > IM_TEXT_MAX_LENGTH
      ? text.substring(0, IM_TEXT_MAX_LENGTH - 20) + t('im.text_truncated')
      : text

    const failedPlatforms: { platform: string; error: string }[] = []
    for (const contact of targets) {
      const adapter = this.getAdapter(contact.platform)
      if (!adapter || !adapter.isConnected()) continue

      try {
        if (options?.markdown) {
          await adapter.sendMarkdown(contact.replyContext, options.title || t('im.notification_title'), truncated)
        } else {
          await adapter.sendText(contact.replyContext, truncated)
        }
        this.lastContact = contact
        log.info(`Proactive notification sent via ${contact.platform}` +
          (failedPlatforms.length > 0 ? ` (fallback from ${failedPlatforms.map(f => f.platform).join(', ')})` : ''))
        return { success: true, platform: contact.platform, failedPlatforms: failedPlatforms.length > 0 ? failedPlatforms : undefined }
      } catch (err: any) {
        const errorMsg = err?.message || 'Unknown error'
        failedPlatforms.push({ platform: contact.platform, error: errorMsg })
        log.error(`Failed to send proactive notification via ${contact.platform}:`, err)
        // 该平台上下文失效时，从联系人池移除，避免后续重复失败
        delete this.contactsByPlatform[contact.platform]
        if (this.lastContact?.platform === contact.platform) {
          this.lastContact = null
        }
        this.persistContacts()
      }
    }

    const lastFailed = failedPlatforms[failedPlatforms.length - 1]
    return { success: false, error: lastFailed?.error || t('im.notification_no_contact'), failedPlatforms }
  }

  // ==================== 消息处理核心 ====================

  /**
   * 处理 IM 平台来的消息
   */
  private async handleIncomingMessage(msg: IMIncomingMessage) {
    if (!this.deps) {
      log.error('Dependencies not set, ignoring message')
      return
    }

    const adapter = this.getAdapter(msg.platform)
    if (!adapter) return

    // 检测该用户是否首次联系（按 platform:userId 精确判断）
    const userKey = `${msg.platform}:${msg.userId}`
    const isFirstContact = !this.knownUsers.has(userKey)

    // 记录最近联系的渠道，用于后续主动推送
    const contact: IMLastContact = {
      platform: msg.platform,
      replyContext: msg.replyContext,
      userId: msg.userId,
      userName: msg.userName,
      chatId: msg.chatId,
      chatType: msg.chatType,
      updatedAt: Date.now(),
    }
    this.lastContact = contact
    this.contactsByPlatform[msg.platform] = contact
    this.persistContacts()

    // 首次联系：标记到消息上，让 Agent 自己决定如何打招呼
    if (isFirstContact) {
      this.knownUsers.add(userKey)
      this.persistKnownUsers()
      msg = { ...msg, isFirstContact: true }
    }

    const replyContext = msg.replyContext

    // 构建完整消息文本（含附件信息）
    const fullMessage = this.buildAgentMessage(msg)

    // Companion Agent 实例
    const companion = this.deps.agentService.createAssistantAgent(AgentService.COMPANION_AGENT_ID)

    // 检查是否有待确认的工具调用（仅对纯文本消息生效）
    if (companion.hasPendingConfirmation() && !msg.attachments?.length) {
      await this.handleConfirmResponse(adapter, replyContext, msg.text)
      return
    }

    // 如果 Agent 正在运行，尝试补充消息（包括 ask_user 的回复）
    if (companion.isRunning()) {
      try {
        if (companion.addUserMessage(fullMessage)) {
          await adapter.sendText(replyContext, t('im.reply_received'))
        } else {
          await adapter.sendText(replyContext, t('im.reply_busy'))
        }
      } catch (err) {
        log.error('Failed to send busy reply:', err)
      }
      return
    }

    // 特殊命令处理（仅对纯文本消息、无附件时生效）
    if (!msg.attachments?.length) {
      const lowerText = msg.text.toLowerCase().trim()
      try {
        if (lowerText === '/status' || lowerText === '状态' || lowerText === 'status') {
          const status = this.getSessionStatus()
          await adapter.sendText(replyContext, status)
          return
        }
        if (lowerText === '/help' || lowerText === '帮助' || lowerText === 'help') {
          await adapter.sendText(replyContext, this.getHelpText())
          return
        }
      } catch (err) {
        log.error('Failed to send command reply:', err)
        return
      }
    }

    // 开始 Agent 任务
    await this.runAgentTask(adapter, replyContext, msg)
  }

  /**
   * 处理确认/拒绝回复
   */
  private async handleConfirmResponse(adapter: IMAdapter, replyContext: any, text: string) {
    const companion = this.deps!.agentService.createAssistantAgent(AgentService.COMPANION_AGENT_ID)
    const lowerText = text.toLowerCase().trim()
    const isApproved = CONFIRM_KEYWORDS.some(kw => lowerText === kw)
    const isRejected = REJECT_KEYWORDS.some(kw => lowerText === kw)

    if (!isApproved && !isRejected) {
      try {
        const status = companion.getRunStatus()
        await adapter.sendText(replyContext,
          t('im.confirm_hint', { toolName: status?.currentToolName || 'unknown' })
        )
      } catch (err) {
        log.error('Failed to send confirm hint:', err)
      }
      return
    }

    const success = companion.confirmToolCall(undefined, isApproved)

    // 同步清除桌面 companion tab 的确认状态
    if (success) {
      const mainWindow = this.deps?.mainWindow
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('agent:confirmResolved', {
          agentId: AgentService.COMPANION_AGENT_ID
        })
      }
    }

    try {
      if (success) {
        await adapter.sendText(replyContext,
          isApproved ? t('im.confirmed') : t('im.rejected')
        )
      } else {
        await adapter.sendText(replyContext, t('im.confirm_failed'))
      }
    } catch (err) {
      log.error('Failed to send confirm result:', err)
    }
  }

  /**
   * 执行 Agent 任务（直接调用 Companion Agent）
   */
  private async runAgentTask(adapter: IMAdapter, replyContext: any, msg: IMIncomingMessage) {
    if (!this.deps) return

    this.activeSession = { adapter, replyContext }
    const fullMessage = this.buildAgentMessage(msg)
    const agentId = AgentService.COMPANION_AGENT_ID

    try {
      await adapter.beginOutboundSession?.(replyContext)
    } catch (err) {
      log.warn('beginOutboundSession failed (ignored):', err)
    }

    let wechatSendFailedNotified = false
    /**
     * 微信发送失败时的兜底通知（HTTP 错误、网络超时等真硬失败才会进来——服务端
     * `errcode=-2 errmsg=unknown` 这种软错误已对齐官方 SDK 静默放行，不再触发本回调）。
     * 两条路：
     *   1. 经 adapter.sendErrorNotice 尝试给用户发一条提示文本（同样可能再次失败，那就算了）。
     *   2. IPC 推 'im:sendFailure' 让桌面前端弹个提示，adapter 完全失联时仍能感知。
     * 两条路都失败也没关系，至少 main 进程日志会留 warn。
     */
    const notifyWechatSendFailure = async (reason?: unknown) => {
      if (msg.platform !== 'wechat' || wechatSendFailedNotified) return
      wechatSendFailedNotified = true
      log.warn('WeChat outbound send failure surfaced to user', {
        userId: msg.userId,
        userName: msg.userName,
        reason: reason ? String(reason) : undefined,
      })
      this.sendToDesktop('im:sendFailure', {
        platform: msg.platform,
        userId: msg.userId,
        userName: msg.userName,
        reason: reason ? String(reason) : undefined,
      })
      try {
        if (adapter.sendErrorNotice) {
          await adapter.sendErrorNotice(replyContext, t('im.wechat_send_failed'))
        } else {
          await adapter.sendText(replyContext, t('im.wechat_send_failed'))
        }
      } catch { /* ignore */ }
    }

    // 结构化工具进度（TOOL_CALL_START / TOOL_CALL_RESULT，item.type=11/12）默认关闭：
    // 微信普通会话客户端不渲染这两种 type，消息虽然能成功送达服务端，但用户端看不见
    // （手机上只剩"处理中"和最终回复，所有工具调用进度全丢）。继续走 TEXT 通知，
    // 让"调用 calendar_list…"这类过程消息真正出现在聊天里。
    // notifyToolProgress 方法本身保留在 adapter 上，留给将来 SDK / Web 客户端等支持
    // 结构化进度的渠道按需启用。
    const useWechatStructuredProgress = false

    try {
      await adapter.sendText(replyContext, t('im.processing'))
    } catch (err) {
      log.error('Failed to send processing notice:', err)
      await notifyWechatSendFailure(err)
    }

    // 确保桌面端有 companion tab（不激活，不抢焦点）
    this.sendToDesktop('watch:ensureTab', { agentId })
    this.sendToDesktop('im:taskStarted', {
      platform: msg.platform, userId: msg.userId,
      userName: msg.userName, message: fullMessage
    })

    const sendProcess = this.config.sendProcessMessages
    const sendThinking = this.config.sendThinkingProcess
    let textBuffer = ''
    let hasSentText = false
    /** 已发送过的"正文"（不含思考过程），用于流式 partial flush 与 onDone final flush 的去重 */
    let lastFlushedBody = ''
    /** 最近一次见到的思考过程（剥 HTML 后的纯文本），用于 onComplete 兜底 */
    let lastThinkingContent = ''
    /**
     * 当前是否有 message step 处于流式态（isStreaming=true）。
     *
     * 关键场景：streaming-tool-executor 在 tool_call.args 收齐时就把 tool_call 定稿
     * 并预执行，**这早于 message step 的流式结束**。如果此时 `sendToolNotify` 内
     * 的 `await flushTextBuffer()` 把 textBuffer 里还没收尾的 partial 文本发出去，
     * 紧接着 message step 真正定稿（比如多了个句号），就会因为 body 字面值不同而
     * 被当成新内容再发一次，最终用户看到「我来查一下...」+「我来查一下...。」两条
     * 几乎一样的消息。
     *
     * 修复策略：partial 文本不出门。flush 在 message 还在流式时直接 return，
     * 留给 message step 定稿时的那次 flush 统一发出完整内容。
     */
    let messageStreaming = false
    const notifiedToolCalls = new Set<string>()
    const sentMessageStepIds = new Set<string>()

    let sendQueue: Promise<void> = Promise.resolve()
    const enqueueSend = (fn: () => Promise<void>): void => {
      sendQueue = sendQueue.then(
        () => fn().catch(err => {
          log.error('Send queue error:', err)
        }),
        // 即使前一个任务失败，也继续执行当前任务
        () => fn().catch(err => {
          log.error('Send queue error (after previous failure):', err)
        })
      )
    }

    /**
     * 流式 message 期间挂起的"工具相关"通知。message 定稿后统一刷入 sendQueue。
     *
     * 背景：streaming-tool-executor 在 tool.args 收齐时就 finalize tool_call 并预执行，
     * 这一切都发生在 message 流式结束**之前**，导致 tool_call onStep（以及随之而来的
     * tool_result onStep）比 message 定稿先到。直接入队会让用户看到「工具通知 → 文字消息」
     * 这种和桌面 UI 反过来的顺序（桌面按 steps 数组位置渲染，message 创建早所以在前）。
     *
     * 设计：tool_call 通知 / tool_result 失败通知统一走 enqueueAfterMessage——message
     * 流式时挂入 pendingAfterMessage，message 定稿那一刻调 flushPendingAfterMessage
     * 把它们成批转入 sendQueue，自然得到「message → 工具」的真实顺序。
     */
    const pendingAfterMessage: Array<() => Promise<void>> = []
    const flushPendingAfterMessage = (): void => {
      while (pendingAfterMessage.length) {
        const fn = pendingAfterMessage.shift()!
        enqueueSend(fn)
      }
    }
    const enqueueAfterMessage = (fn: () => Promise<void>): void => {
      if (messageStreaming) {
        pendingAfterMessage.push(fn)
      } else {
        enqueueSend(fn)
      }
    }

    /**
     * 把当前 textBuffer 作为一条消息发送出去。
     *
     * 行为约定：
     * - 思考过程（<details> 块）由 sendThinkingProcess 开关控制：开启时与正文一起发，
     *   关闭（默认）时剥离仅留存到 lastThinkingContent，避免给 IM 用户刷屏。无论开关
     *   与否，onComplete 兜底逻辑（无实质正文时发思考过程）始终生效。
     * - 去重锚点是 body（不含 thinking）：流式中 thinking 可能反复变化，但同一段
     *   body 不该被多次推送。「tool_call 触发 flush + onDone final flush」的重复
     *   场景由此覆盖。
     * - sendMarkdown 失败时不更新已发送状态，否则 onComplete 会误判为"已送达"而把最终
     *   回复一并跳过，表现为"任务完成了但没出最终消息"。
     */
    const flushTextBuffer = async () => {
      if (!textBuffer) return
      // partial 文本不能外发（详见 messageStreaming 注释）。textBuffer 不在这里清空，
      // 等 message 定稿后的 flush 用完整内容覆盖再统一发出。
      if (messageStreaming) return
      const content = textBuffer
      textBuffer = ''
      const { thinking, body } = splitThinkingAndBody(content)
      if (thinking) lastThinkingContent = thinking
      if (!body || body === lastFlushedBody) return
      const toSend = sendThinking && thinking
        ? `${formatThinkingForIM(thinking)}\n\n${body}`
        : body
      try {
        await adapter.sendMarkdown(replyContext, '旗鱼', toSend)
        hasSentText = true
        lastFlushedBody = body
      } catch (err) {
        log.error('Failed to send text:', err)
        await notifyWechatSendFailure(err)
      }
    }

    const mainWindow = this.deps.mainWindow

    try {
      const context = {
        terminalOutput: [] as string[],
        systemInfo: { os: getLocalOS(), shell: getDefaultShell() },
        terminalType: 'assistant' as const,
        remoteChannel: msg.platform as RemoteChannel,
        ...(msg.isFirstContact ? {
          contextHint: t('im.first_contact_context', { userName: msg.userName, platform: msg.platform })
        } : {})
      }

      await this.deps.agentService.runAssistant(agentId, fullMessage, context, {
        enabled: true, commandTimeout: 30000,
        autoExecuteSafe: true, autoExecuteModerate: true,
        executionMode: this.config.executionMode,
        debugMode: false
      }, undefined, {
        onStep: (_runId: string, step: any) => {
          // 同步到桌面 companion tab
          if (mainWindow && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('agent:step', {
              agentId, step: JSON.parse(JSON.stringify(step))
            })
          }

          if (step.type === 'message' && step.content) {
            if (step.isStreaming) {
              messageStreaming = true
              textBuffer = step.content
            } else if (!sentMessageStepIds.has(step.id)) {
              sentMessageStepIds.add(step.id)
              messageStreaming = false
              textBuffer = step.content
              if (sendProcess) {
                enqueueSend(() => flushTextBuffer())
              }
              // message 定稿那一刻，把流式期间挂起的工具通知刷入 sendQueue，
              // 顺序自然变为「message → 工具相关」，与桌面 UI 对齐
              flushPendingAfterMessage()
            } else {
              // 同 step.id 的非流式回调（比如 finalize 阶段二次推送）也算定稿
              messageStreaming = false
              flushPendingAfterMessage()
            }
          } else if (step.type === 'asking' && step.toolArgs) {
            const askKey = step.id || `asking:${step.toolArgs.question}`
            if (notifiedToolCalls.has(askKey)) return
            notifiedToolCalls.add(askKey)

            const sendAsk = async () => {
              if (sendProcess) {
                await flushTextBuffer()
              } else {
                textBuffer = ''
              }
              const question = step.toolArgs.question || step.content || ''
              const options = step.toolArgs.options as string[] | undefined
              const allowMultiple = step.toolArgs.allow_multiple as boolean | undefined
              try {
                if (options && options.length > 0 && adapter.sendAskCard) {
                  await adapter.sendAskCard(replyContext, question, options, !!allowMultiple)
                } else {
                  const lines = [t('im.need_reply'), '', question]
                  if (options && options.length > 0) {
                    lines.push('')
                    options.forEach((opt: string, i: number) => { lines.push(`${i + 1}. ${opt}`) })
                    lines.push('', t('im.need_reply_select'))
                  } else {
                    lines.push('', t('im.need_reply_input'))
                  }
                  await adapter.sendMarkdown(replyContext, t('im.need_reply_title'), lines.join('\n'))
                }
              } catch { /* ignore */ }
            }
            enqueueSend(sendAsk)
          } else if (step.type === 'tool_call' && step.toolName) {
            if (step.toolName === 'ask_user') return
            if (!sendProcess) return
            // 流式 tool_call 会先以 isStreaming=true、无 toolArgs 回调；若此时发通知并记入
            // notifiedToolCalls，后续执行器 updateStep 带上 toolArgs 会因同 step.id 被去重跳过，
            // IM 侧就只剩工具名。等非流式态（执行器认领卡片后）再通知。
            if (step.isStreaming) return
            const progressCallId = step.toolCallId || step.id
            const toolCallKey = toolProcessNotifyKey(
              step.toolName,
              step.toolArgs as Record<string, unknown> | undefined,
              progressCallId,
            )
            // callIdKey 是按 toolCallId 维度的"该 tool 已通知"标志（不带 args hash），
            // 与下面 tool_result 失败分支共享：失败先到时会先入队一条 🔧 并 add 这个 key，
            // 此处真正的 finalize onStep 拿到时直接跳过，避免「❌ → 🔧」乱序后再补一条 🔧。
            const callIdKey = `tool_start_by_call_id:${progressCallId}`
            if (notifiedToolCalls.has(toolCallKey) || notifiedToolCalls.has(callIdKey)) return
            notifiedToolCalls.add(toolCallKey)
            notifiedToolCalls.add(callIdKey)

            const sendToolNotify = async () => {
              await flushTextBuffer()
              try {
                if (useWechatStructuredProgress) {
                  adapter.notifyToolProgress!(replyContext, {
                    phase: 'start',
                    toolName: step.toolName!,
                    toolCallId: progressCallId,
                  })
                } else {
                  await adapter.sendText(replyContext,
                    formatToolNotification(step.toolName, step.toolArgs as Record<string, unknown>))
                }
              } catch (err) {
                log.error('Failed to send tool notification:', err)
                await notifyWechatSendFailure(err)
              }
            }
            enqueueAfterMessage(sendToolNotify)
          } else if (
            step.type === 'tool_result' &&
            sendProcess &&
            step.toolName &&
            step.toolName !== 'ask_user' &&
            step.success === false &&
            !isImDeliveryToolFailure(step)
          ) {
            // streaming-tool-executor 的 onToolCompleted 顺序是 ensureToolResultStep → finalizeToolCallStep，
            // 因此对应 tool_call 的 isStreaming=false onStep 会比这条 tool_result 晚一拍到 IMService。
            // 如果直接发 ❌，会跑到「🔧 调用 xxx」之前，观感像「失败信息凭空出现」。
            // 这里先按 toolCallId 补一条 🔧（去重锚点同 tool_call 分支共享），让随后真正的
            // tool_call finalize onStep 因 callIdKey 已存在而跳过自身的入队，顺序自然变为 🔧 → ❌。
            const progressCallId = step.toolCallId ?? step.id
            const callIdKey = `tool_start_by_call_id:${progressCallId}`
            if (step.toolName && !notifiedToolCalls.has(callIdKey)) {
              notifiedToolCalls.add(callIdKey)
              const startToolName = step.toolName
              const startToolArgs = step.toolArgs as Record<string, unknown> | undefined
              const sendToolStartRetro = async () => {
                await flushTextBuffer()
                try {
                  await adapter.sendText(
                    replyContext,
                    formatToolNotification(startToolName, startToolArgs),
                  )
                } catch (err) {
                  log.error('Failed to send tool notification (retro):', err)
                  await notifyWechatSendFailure(err)
                }
              }
              enqueueAfterMessage(sendToolStartRetro)
            }

            // 工具失败补一条 ❌ 提示，让用户能与成功调用区分开。
            // 成功不发"✅"——用 burst 风险换不大的收益不值，最终回复会体现成果。
            const failureKey = `tool_failure:${progressCallId}:${step.toolName}`
            if (notifiedToolCalls.has(failureKey)) return
            notifiedToolCalls.add(failureKey)

            const sendToolFailure = async () => {
              try {
                await adapter.sendText(replyContext, formatToolFailureNotification(step))
              } catch (err) {
                log.error('Failed to send tool failure notification:', err)
                await notifyWechatSendFailure(err)
              }
            }
            enqueueAfterMessage(sendToolFailure)
          } else if (step.type === 'tool_result' && isImDeliveryToolFailure(step)) {
            // 投递类工具失败必须推到 IM（与 sendProcess 无关），避免用户只在桌面看到错误
            const resultKey = step.id || `tool_result:${step.toolCallId ?? ''}:${step.toolName}`
            if (notifiedToolCalls.has(resultKey)) return
            notifiedToolCalls.add(resultKey)

            const sendDeliveryFailure = async () => {
              try {
                await adapter.sendText(replyContext, formatImDeliveryToolFailure(step))
              } catch (err) {
                log.error('Failed to send IM delivery tool failure:', err)
                await notifyWechatSendFailure(err)
              }
            }
            enqueueSend(sendDeliveryFailure)
          }
        },

        onNeedConfirm: (confirmation: any) => {
          // 同步到桌面 companion tab（与 onStep/onComplete/onError 对齐）
          if (mainWindow && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('agent:needConfirm', {
              agentId,
              toolCallId: confirmation.toolCallId,
              toolName: confirmation.toolName,
              toolArgs: JSON.parse(JSON.stringify(confirmation.toolArgs)),
              riskLevel: confirmation.riskLevel,
              displayName: confirmation.displayName
            })
          }

          const sendConfirm = async () => {
            if (sendProcess) {
              await flushTextBuffer()
            } else {
              textBuffer = ''
            }
            const argsText = JSON.stringify(confirmation.toolArgs, null, 2)
              .substring(0, 500)
            try {
              // 优先使用交互卡片（带按钮），回退到纯 Markdown
              if (adapter.sendConfirmCard) {
                await adapter.sendConfirmCard(
                  replyContext,
                  confirmation.toolName,
                  argsText,
                  confirmation.riskLevel
                )
              } else {
                const riskEmoji = confirmation.riskLevel === 'dangerous' ? '🔴' : '🟡'
                await adapter.sendMarkdown(replyContext, t('im.need_confirm'), [
                  t('im.need_confirm_title', { riskEmoji }),
                  '',
                  t('im.need_confirm_tool', { toolName: confirmation.toolName }),
                  t('im.need_confirm_risk', { riskLevel: confirmation.riskLevel }),
                  t('im.need_confirm_args'),
                  '```',
                  argsText,
                  '```',
                  '',
                  t('im.need_confirm_action'),
                ].join('\n'))
              }
            } catch { /* ignore */ }
          }
          enqueueSend(sendConfirm)
        },

        onComplete: (_runId: string, result: string) => {
          // 兜底：若 task 在 message 流式中途结束（罕见，但 onComplete 触发时若有遗留），
          // 把 pendingAfterMessage 刷掉，避免工具通知永远卡住
          messageStreaming = false
          flushPendingAfterMessage()
          const finish = async () => {
            if (sendProcess) {
              await flushTextBuffer()
            } else {
              textBuffer = ''
              lastFlushedBody = ''
            }
            // result 可能本身就是 fallback 占位（AI 没产出 content 时 executeLoop 给的兜底文本）。
            // 这种情况不当作"实质回复"发出去，转而走思考过程兜底。
            const trimmedResult = result?.trim() || ''
            const isFallback =
              !trimmedResult ||
              trimmedResult === t('agent.no_response') ||
              trimmedResult === t('agent.task_complete') ||
              trimmedResult === t('error.operation_aborted')

            if (!isFallback) {
              const { thinking, body } = splitThinkingAndBody(result)
              if (thinking) lastThinkingContent = thinking
              // 不允许 fallback 回 raw result：万一后端把思考块塞进 content 字段，
              // raw 文本里残留的 <details> 标签会原样推到 IM 用户面前。body 为空时走思考过程兜底。
              if (body && body !== lastFlushedBody) {
                try {
                  await adapter.sendMarkdown(replyContext, '旗鱼', body)
                  hasSentText = true
                  lastFlushedBody = body
                } catch (err) {
                  log.error('Failed to send final result:', err)
                  await notifyWechatSendFailure(err)
                }
                return
              }
            }

            if (hasSentText) return

            // 整个会话从未发过实质正文：把最近的思考过程作为兜底发给用户，
            // 满足"最后只有思考过程、没有正文时也能让用户知道 AI 想了什么"的需求。
            if (lastThinkingContent) {
              try {
                await adapter.sendMarkdown(replyContext, '旗鱼', formatThinkingForIM(lastThinkingContent))
              } catch (err) {
                log.error('Failed to send thinking fallback:', err)
                await notifyWechatSendFailure(err)
              }
            } else {
              try {
                await adapter.sendText(replyContext, t('im.task_complete'))
              } catch (err) {
                log.error('Failed to send task complete:', err)
                await notifyWechatSendFailure(err)
              }
            }
          }
          enqueueSend(finish)

          if (mainWindow && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('agent:complete', { agentId, result })
          }
          this.sendToDesktop('im:taskComplete', {
            platform: msg.platform, userId: msg.userId
          })
        },

        onError: (_runId: string, error: string) => {
          // 同 onComplete：兜底刷掉流式期间挂起的工具通知
          messageStreaming = false
          flushPendingAfterMessage()
          const finish = async () => {
            if (sendProcess) {
              await flushTextBuffer()
            } else {
              textBuffer = ''
              lastFlushedBody = ''
            }
            try {
              await adapter.sendText(replyContext, t('im.task_error', { error }))
            } catch (sendErr) {
              log.error('Failed to send task error:', sendErr)
              await notifyWechatSendFailure(sendErr)
            }
          }
          enqueueSend(finish)

          if (mainWindow && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('agent:error', { agentId, error })
          }
          this.sendToDesktop('im:taskError', {
            platform: msg.platform, userId: msg.userId, error
          })
        }
      })
    } catch (err: any) {
      try {
        await adapter.sendText(replyContext, `❌ ${err.message || 'Unknown error'}`)
      } catch { /* ignore */ }
    } finally {
      try { await sendQueue } catch { /* ignore */ }
      try {
        await Promise.resolve(adapter.endOutboundSession?.(replyContext))
      } catch (err) {
        log.warn('endOutboundSession failed (ignored):', err)
      }
      this.activeSession = null
    }
  }

  // ==================== 文件发送（供 Agent 工具调用） ====================

  /**
   * 为当前活跃的 IM 会话发送文件
   * 优先使用活跃会话，无活跃会话时通过最近联系人主动推送
   */
  async sendFileForCurrentSession(filePath: string, fileName?: string): Promise<SendFileResult> {
    if (this.activeSession) {
      try {
        await this.activeSession.adapter.sendFile(
          this.activeSession.replyContext,
          filePath,
          fileName
        )
        return { success: true }
      } catch (err: any) {
        log.error('Failed to send file:', err)
        return { success: false, error: err.message || 'Failed to send file' }
      }
    }

    return this.sendFileProactive(filePath, fileName)
  }

  /**
   * 异步发送文件：立即返回 task_id，后台执行上传。
   * Agent 通过 waitFileTransfer 轮询任务状态。
   */
  startFileSend(filePath: string, fileName?: string): string {
    const taskId = `ft-${this.fileTransferNextId++}`
    const displayName = fileName || filePath.split('/').pop() || filePath
    const task: FileTransferTask = {
      taskId,
      displayName,
      status: 'uploading',
      startedAt: Date.now(),
      _waiters: [],
    }
    this.fileTransferTasks.set(taskId, task)

    // 后台执行，不 await
    const completeTask = (status: 'done' | 'failed', error?: string) => {
      task.status = status
      task.error = error
      task.finishedAt = Date.now()
      const waiters = task._waiters.splice(0)
      for (const w of waiters) w(status)
      // 5 分钟后清理任务记录
      setTimeout(() => this.fileTransferTasks.delete(taskId), FILE_TRANSFER_KEEP_MS)
    }
    void this.sendFileForCurrentSession(filePath, fileName)
      .then((result) => completeTask(result.success ? 'done' : 'failed', result.error))
      .catch((err: unknown) => {
        log.error(`startFileSend ${taskId}: unexpected error`, err)
        completeTask('failed', err instanceof Error ? err.message : String(err))
      })

    log.info(`startFileSend: task=${taskId} file=${displayName}`)
    return taskId
  }

  getFileTransferTask(taskId: string): FileTransferTask | undefined {
    return this.fileTransferTasks.get(taskId)
  }

  /**
   * 等待文件传输任务完成，最多等 waitMs 毫秒。
   * 返回原因：'done' | 'failed' | 'timeout' | 'aborted'
   */
  waitFileTransfer(
    taskId: string,
    waitMs: number,
    isAborted: () => boolean
  ): Promise<'done' | 'failed' | 'timeout' | 'aborted'> {
    const task = this.fileTransferTasks.get(taskId)
    if (!task) return Promise.resolve('failed')
    if (task.status !== 'uploading') return Promise.resolve(task.status)

    return new Promise<'done' | 'failed' | 'timeout' | 'aborted'>((resolve) => {
      let settled = false
      const settle = (reason: 'done' | 'failed' | 'timeout' | 'aborted') => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(abortPoller)
        task._waiters = task._waiters.filter((w) => w !== waiter)
        resolve(reason)
      }

      const timer = setTimeout(() => settle('timeout'), waitMs)

      // 每 200ms 检查一次用户是否中断
      const abortPoller = setInterval(() => {
        if (isAborted()) settle('aborted')
      }, 200)

      const waiter = (status: 'done' | 'failed') => settle(status)
      task._waiters.push(waiter)
    })
  }

  /**
   * 为当前活跃的 IM 会话发送图片（内联显示）
   * 优先使用活跃会话，无活跃会话时通过最近联系人主动推送
   */
  async sendImageForCurrentSession(filePath: string): Promise<SendFileResult> {
    if (this.activeSession) {
      try {
        await this.activeSession.adapter.sendImage(
          this.activeSession.replyContext,
          filePath
        )
        return { success: true }
      } catch (err: any) {
        log.error('Failed to send image:', err)
        return { success: false, error: err.message || 'Failed to send image' }
      }
    }

    return this.sendImageProactive(filePath)
  }

  /**
   * 当前是否有活跃的 IM 会话或可用的最近联系人
   */
  hasActiveSession(): boolean {
    return this.activeSession !== null || this.lastContact !== null
  }

  /**
   * 通过最近联系人主动发送图片
   */
  private async sendImageProactive(filePath: string): Promise<SendFileResult> {
    const targets = this.getNotificationTargets()
    for (const contact of targets) {
      const adapter = this.getAdapter(contact.platform)
      if (!adapter || !adapter.isConnected()) continue
      try {
        await adapter.sendImage(contact.replyContext, filePath)
        log.info(`Proactive image sent via ${contact.platform}`)
        return { success: true }
      } catch (err: any) {
        log.error(`Failed to send image via ${contact.platform}:`, err)
      }
    }
    return { success: false, error: 'No available IM channel' }
  }

  /**
   * 通过最近联系人主动发送文件
   */
  private async sendFileProactive(filePath: string, fileName?: string): Promise<SendFileResult> {
    const targets = this.getNotificationTargets()
    for (const contact of targets) {
      const adapter = this.getAdapter(contact.platform)
      if (!adapter || !adapter.isConnected()) continue
      try {
        await adapter.sendFile(contact.replyContext, filePath, fileName)
        log.info(`Proactive file sent via ${contact.platform}`)
        return { success: true }
      } catch (err: any) {
        log.error(`Failed to send file via ${contact.platform}:`, err)
      }
    }
    return { success: false, error: 'No available IM channel' }
  }

  // ==================== 工具方法 ====================

  /**
   * 将消息文本和附件信息组装为传给 Agent 的完整消息
   * 包含文件路径和处理指引，帮助 Agent 正确处理不同类型的文件
   */
  private buildAgentMessage(msg: IMIncomingMessage): string {
    let text = msg.text || ''

    if (msg.attachments && msg.attachments.length > 0) {
      const BINARY_TYPES = new Set<IMAttachment['type']>(['image', 'audio', 'video'])

      const typeI18nKeys: Record<IMAttachment['type'], Parameters<typeof t>[0]> = {
        image: 'im.attachment_image',
        audio: 'im.attachment_audio',
        video: 'im.attachment_video',
        file: 'im.attachment_file',
      }

      const fileDescriptions = msg.attachments.map(a => {
        const isBinary = BINARY_TYPES.has(a.type)
        const typeLabel = t(typeI18nKeys[a.type] || 'im.attachment_file')
        let desc = `- [${typeLabel}] ${a.fileName} → ${a.localPath}`
        if (isBinary) {
          desc += t('im.attachment_binary_warn')
        }
        return desc
      })

      const hasBinary = msg.attachments.some(a => BINARY_TYPES.has(a.type))
      const guidance = hasBinary ? t('im.attachment_binary_guidance') : ''

      const fileList = fileDescriptions.join('\n')

      if (text) {
        text += `\n\n${t('im.attachment_sent')}\n${fileList}${guidance}`
      } else {
        text = `${t('im.attachment_sent_only')}\n${fileList}${guidance}${t('im.attachment_help_hint')}`
      }
    }

    return text
  }

  private getAdapter(platform: IMPlatform): IMAdapter | null {
    if (platform === 'dingtalk') return this.dingtalkAdapter
    if (platform === 'feishu') return this.feishuAdapter
    if (platform === 'slack') return this.slackAdapter
    if (platform === 'telegram') return this.telegramAdapter
    if (platform === 'wecom') return this.wecomAdapter
    if (platform === 'wechat') return this.wechatAdapter
    return this.pluginAdapters.get(platform) ?? null
  }

  /**
   * 注册插件提供的 IM adapter
   */
  registerAdapter(adapter: IMAdapter): void {
    this.pluginAdapters.set(adapter.platform, adapter)
    adapter.onMessage = (msg) => this.handleIncomingMessage(msg)
    adapter.onConnectionChange = (connected) => {
      if (connected) {
        log.info(`Plugin IM adapter "${adapter.platform}" connected`)
      }
    }
    log.info(`Plugin IM adapter registered: ${adapter.platform}`)
  }

  private loadPersistedContacts(): void {
    const configService = getConfigService()

    // 先加载已知用户集合
    let hasPersistedKnownUsers = false
    try {
      const stored = configService.get('imKnownUsers') as string[] | undefined
      if (Array.isArray(stored) && stored.length > 0) {
        this.knownUsers = new Set(stored)
        hasPersistedKnownUsers = true
      }
    } catch (err) {
      log.warn('Failed to load known users:', err)
    }

    // 再加载各平台联系记录
    try {
      const stored = configService.get('imLastContacts') as Record<string, unknown> | undefined
      if (stored && typeof stored === 'object') {
        const parsed: Partial<Record<IMPlatform, IMLastContact>> = {}
        const platforms: IMPlatform[] = ['dingtalk', 'feishu', 'slack', 'telegram', 'wecom', 'wechat']
        for (const platform of platforms) {
          const raw = stored[platform] as IMLastContact | undefined
          if (this.isValidContact(raw) && !this.isContactExpired(raw)) {
            parsed[platform] = raw
          }
        }
        this.contactsByPlatform = parsed

        // 向后兼容：老版本没有 imKnownUsers，从 contactsByPlatform 迁移
        if (!hasPersistedKnownUsers) {
          for (const contact of Object.values(this.contactsByPlatform)) {
            if (contact?.userId) {
              this.knownUsers.add(`${contact.platform}:${contact.userId}`)
            }
          }
          if (this.knownUsers.size > 0) {
            this.persistKnownUsers()
          }
        }
      }
    } catch (err) {
      log.warn('Failed to load persisted contacts:', err)
      this.contactsByPlatform = {}
    }
  }

  private persistContacts(): void {
    try {
      const configService = getConfigService()
      const serializable: Record<string, unknown> = {}
      const platforms: IMPlatform[] = ['dingtalk', 'feishu', 'slack', 'telegram', 'wecom', 'wechat']
      for (const platform of platforms) {
        const contact = this.contactsByPlatform[platform]
        if (!contact) continue
        const safe = this.toSerializableContact(contact)
        if (safe) serializable[platform] = safe
      }
      configService.set('imLastContacts', serializable)
    } catch (err) {
      log.warn('Failed to persist contacts:', err)
    }
  }

  private persistKnownUsers(): void {
    try {
      const configService = getConfigService()
      configService.set('imKnownUsers', Array.from(this.knownUsers))
    } catch (err) {
      log.warn('Failed to persist known users:', err)
    }
  }

  private toSerializableContact(contact: IMLastContact): IMLastContact | null {
    try {
      // 防御性校验：仅持久化可 JSON 序列化的 replyContext
      JSON.stringify(contact.replyContext)
      return contact
    } catch {
      log.warn(`Skip persisting contact for ${contact.platform}: replyContext is not serializable`)
      return null
    }
  }

  private isValidContact(contact: any): contact is IMLastContact {
    return !!contact
      && typeof contact.platform === 'string'
      && typeof contact.replyContext !== 'undefined'
      && typeof contact.userId === 'string'
      && typeof contact.userName === 'string'
      && (contact.chatType === 'single' || contact.chatType === 'group')
      && typeof contact.updatedAt === 'number'
  }

  private isContactExpired(contact: IMLastContact): boolean {
    return (Date.now() - contact.updatedAt) > IMService.CONTACT_TTL_MS
  }

  private pickMostRecentContact(
    contacts: Partial<Record<IMPlatform, IMLastContact>>
  ): IMLastContact | null {
    const list = Object.values(contacts)
      .filter((contact): contact is IMLastContact => !!contact)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return list[0] || null
  }

  private getNotificationTargets(): IMLastContact[] {
    const connectedPlatforms: IMPlatform[] = ['dingtalk', 'feishu', 'slack', 'telegram', 'wecom', 'wechat']
      .filter((platform) => {
        const adapter = this.getAdapter(platform)
        return !!adapter && adapter.isConnected()
      })

    if (connectedPlatforms.length === 0) return []

    const candidates = connectedPlatforms
      .map((platform) => this.contactsByPlatform[platform])
      .filter((contact): contact is IMLastContact => !!contact && !this.isContactExpired(contact))
      .sort((a, b) => b.updatedAt - a.updatedAt)

    if (candidates.length === 0) return []

    const preferredPlatform = this.lastContact?.platform
    if (preferredPlatform) {
      const preferred = candidates.find(c => c.platform === preferredPlatform)
      if (preferred) {
        return [preferred, ...candidates.filter(c => c.platform !== preferredPlatform)]
      }
    }
    return candidates
  }

  private getSessionStatus(): string {
    const companion = this.deps?.agentService?.createAssistantAgent(AgentService.COMPANION_AGENT_ID)
    const runStatus = companion?.getRunStatus()
    const connected = (name: string, isConn: boolean) =>
      `${name}: ${isConn ? '✅' : '❌'}`

    return [
      t('im.status_title'),
      `${t('im.status_state')}: ${runStatus?.isRunning ? t('im.status_running') : t('im.status_idle')}`,
      `${t('im.status_exec_mode')}: ${this.config.executionMode}`,
      connected('DingTalk', this.isDingTalkConnected()),
      connected('Feishu', this.isFeishuConnected()),
      connected('Slack', this.isSlackConnected()),
      connected('Telegram', this.isTelegramConnected()),
      connected('WeCom', this.isWeComConnected()),
      connected('WeChat', this.isWeChatConnected()),
    ].join('\n')
  }

  private getHelpText(): string {
    return [
      t('im.help_title'),
      '',
      t('im.help_desc'),
      '',
      t('im.help_commands'),
      t('im.help_cmd_help'),
      t('im.help_cmd_status'),
      t('im.help_cmd_clear'),
      '',
      t('im.help_confirm'),
      t('im.help_confirm_approve'),
      t('im.help_confirm_reject'),
    ].join('\n')
  }

  private sendToDesktop(channel: string, data: any) {
    try {
      if (this.deps?.mainWindow && !this.deps.mainWindow.webContents.isDestroyed()) {
        this.deps.mainWindow.webContents.send(channel, data)
      }
    } catch { /* ignore */ }
  }
}

// ==================== 单例管理 ====================

let imServiceInstance: IMService | null = null

export function getIMService(): IMService {
  if (!imServiceInstance) {
    imServiceInstance = new IMService()
  }
  return imServiceInstance
}
