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

import type { ExecutionMode } from '@shared/types'
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
}

/**
 * 将工具调用格式化为用户友好的通知文本
 * 通过映射复用 i18n 已有翻译，无匹配时 fallback 到 toolName
 */
function formatToolNotification(toolName: string, toolArgs?: Record<string, unknown>): string {
  const icon = TOOL_ICONS[toolName] || '🔧'
  const i18nKey = TOOL_I18N_MAP[toolName]
  const label = i18nKey ? t(i18nKey) : toolName

  // 根据工具类型附加关键参数
  let detail = ''
  if (toolName === 'execute_command' || toolName === 'exec') {
    const cmd = toolArgs?.command ? String(toolArgs.command) : ''
    detail = cmd ? `\n$ ${cmd.length > 200 ? cmd.substring(0, 200) + '...' : cmd}` : ''
  } else if (toolArgs?.path) {
    detail = `  ${toolArgs.path}`
  } else if (toolName === 'file_search' && (toolArgs?.pattern || toolArgs?.query)) {
    detail = `  ${toolArgs.pattern || toolArgs.query}`
  } else if ((toolName === 'skill' || toolName === 'load_skill' || toolName === 'load_user_skill') && (toolArgs?.skill_id || toolArgs?.name)) {
    detail = `  ${toolArgs.skill_id || toolArgs.name}`
  } else if (toolName === 'send_control_key' && toolArgs?.key) {
    detail = ` ${toolArgs.key}`
  } else if (toolName === 'wait' && toolArgs?.seconds) {
    detail = ` ${toolArgs.seconds}s`
  } else if (toolName === 'dispatch_agents' && Array.isArray(toolArgs?.tasks)) {
    detail = ` ${(toolArgs.tasks as Array<unknown>).length} 个子任务`
  }

  return `${icon} ${label}${detail}`
}

/**
 * 将 AI 输出中的 HTML 思考块（<details>/<blockquote>）转为 IM 友好的 > 引用格式
 * 桌面端用 HTML 折叠面板展示思考过程，但 IM 平台（飞书/钉钉等）不支持这些 HTML 标签
 */
function formatContentForIM(content: string): string {
  let result = content.replace(/\r\n/g, '\n')

  // 1) 完整 <details> 块：提取 summary 和引用内容
  result = result.replace(
    /<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>\s*<blockquote\b[^>]*>\s*([\s\S]*?)\s*<\/blockquote>\s*<\/details>/g,
    (_m, summary: string, body: string) => {
      const title = summary.replace(/<[^>]+>/g, '').trim()
      if (!title) return ''
      const quoted = body.trim().split('\n').map((l: string) => `> ${l}`).join('\n')
      return `**${title}**\n\n${quoted}`
    }
  )

  // 2) 未闭合的 <details> 块（流式中途 flush）
  result = result.replace(
    /<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>\s*(?:<blockquote\b[^>]*>\s*)?([\s\S]*)$/,
    (_m, summary: string, body: string) => {
      const title = summary.replace(/<[^>]+>/g, '').trim()
      if (!title) return ''
      const cleaned = body.replace(/<\/?(blockquote|details)\b[^>]*>/g, '').trim()
      if (!cleaned) return `**${title}**`
      const quoted = cleaned.split('\n').map((l: string) => `> ${l}`).join('\n')
      return `**${title}**\n\n${quoted}`
    }
  )

  return result
}

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
      await adapter.sendText(replyContext, t('im.processing'))
    } catch { /* ignore */ }

    // 确保桌面端有 companion tab（不激活，不抢焦点）
    this.sendToDesktop('watch:ensureTab', { agentId })
    this.sendToDesktop('im:taskStarted', {
      platform: msg.platform, userId: msg.userId,
      userName: msg.userName, message: fullMessage
    })

    const sendProcess = this.config.sendProcessMessages
    let textBuffer = ''
    let hasSentText = false
    let lastFlushedContent = ''
    const notifiedToolCalls = new Set<string>()
    const sentMessageStepIds = new Set<string>()

    let sendQueue: Promise<void> = Promise.resolve()
    const enqueueSend = (fn: () => Promise<void>): void => {
      sendQueue = sendQueue.then(() => fn().catch(err => {
        log.error('Send queue error:', err)
      }))
    }

    /**
     * 把当前 textBuffer 作为一条消息发送出去。
     *
     * 处理两类容易出现"重复"或"丢失"的情况：
     * 1) 流式 message 期间被 tool_call 触发先 flush 一次，onDone 把同一 streamStep 标记为
     *    final 后又 flush 一次：两次内容通常一致（OpenAI 协议下 content 在 tool_call 之前就完成）。
     *    通过对 formatContentForIM 后的文本与 lastFlushedContent 比对去重，避免发出重复消息。
     * 2) sendMarkdown 抛错时（contextToken 失效 / 网络抖动等）若仍然把 lastFlushedContent / hasSentText
     *    标记为"已发送"，会让 onComplete 的去重判断把"实际未送达"的内容当成已送达，从而把最终回复
     *    一并跳过 —— 用户看到的就是任务"完成了但没出最终消息"。状态仅在发送成功时更新。
     */
    const flushTextBuffer = async () => {
      if (!textBuffer) return
      const content = textBuffer
      textBuffer = ''
      const text = formatContentForIM(content)
      if (text === lastFlushedContent) return
      try {
        await adapter.sendMarkdown(replyContext, '旗鱼', text)
        hasSentText = true
        lastFlushedContent = text
      } catch (err) {
        log.error('Failed to send text:', err)
      }
    }

    const mainWindow = this.deps.mainWindow

    try {
      const context = {
        terminalOutput: [] as string[],
        systemInfo: { os: getLocalOS(), shell: getDefaultShell() },
        terminalType: 'assistant' as const,
        remoteChannel: msg.platform,
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
              textBuffer = step.content
            } else if (!sentMessageStepIds.has(step.id)) {
              sentMessageStepIds.add(step.id)
              textBuffer = step.content
              if (sendProcess) {
                enqueueSend(() => flushTextBuffer())
              }
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
            const toolCallKey = step.id || `${step.toolName}:${JSON.stringify(step.toolArgs || {})}`
            if (notifiedToolCalls.has(toolCallKey)) return
            notifiedToolCalls.add(toolCallKey)

            const sendToolNotify = async () => {
              await flushTextBuffer()
              try {
                await adapter.sendText(replyContext,
                  formatToolNotification(step.toolName, step.toolArgs as Record<string, unknown>))
              } catch { /* ignore */ }
            }
            enqueueSend(sendToolNotify)
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
              riskLevel: confirmation.riskLevel
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
          const finish = async () => {
            if (sendProcess) {
              await flushTextBuffer()
            } else {
              textBuffer = ''
              lastFlushedContent = ''
            }
            // 与 lastFlushedContent 同维度比较（lastFlushedContent 存的是 formatContentForIM 后的原文，未 trim）
            // 否则当 result 含 <details> / <blockquote> 时永远判为"不同"，会把已发送过的最终回复重复推一遍
            const formatted = result?.trim() ? formatContentForIM(result) : ''
            if (formatted && formatted !== lastFlushedContent) {
              try {
                await adapter.sendMarkdown(replyContext, '旗鱼', formatted)
                hasSentText = true
                lastFlushedContent = formatted
              } catch (err) {
                log.error('Failed to send final result:', err)
              }
            } else if (!hasSentText) {
              try { await adapter.sendText(replyContext, t('im.task_complete')) } catch { /* ignore */ }
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
          const finish = async () => {
            if (sendProcess) {
              await flushTextBuffer()
            } else {
              textBuffer = ''
              lastFlushedContent = ''
            }
            try { await adapter.sendText(replyContext, t('im.task_error', { error })) } catch { /* ignore */ }
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
