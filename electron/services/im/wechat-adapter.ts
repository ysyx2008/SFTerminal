// 微信 IM Adapter — 薄壳实现，业务逻辑全部转发到 vendored @tencent-weixin/openclaw-weixin。
// 本文件只承担：QR 登录流程、长轮询编排、IMAdapter 接口适配、附件下载组装。
//
// 注意：vendored 的 session-guard 是模块级状态（按 accountKey 隔离）；本 adapter
// 实例间共享但 SailFish 单 bot 场景下没有冲突。

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { IMAdapter, IMIncomingMessage, IMPlatform, WeChatConfig, IMAttachment } from './types'
import { IM_TEXT_MAX_LENGTH } from './types'
import { createLogger } from '../../utils/logger'

import {
  apiGetFetch,
  getUpdates as vendoredGetUpdates,
  notifyStart as vendoredNotifyStart,
  notifyStop as vendoredNotifyStop,
} from './wechat/api/api'
import type { WeixinApiOptions } from './wechat/api/api'
import { WeixinConfigManager } from './wechat/api/config-cache'
import {
  SESSION_EXPIRED_ERRCODE,
  assertSessionActive,
  pauseSession,
} from './wechat/api/session-guard'
import { sendMessageWeixin } from './wechat/messaging/send'
import { sendWeixinMediaFile } from './wechat/messaging/send-media'
import {
  setContextToken,
  getContextToken,
  restoreContextTokens,
} from './wechat/messaging/inbound'
import { downloadAndDecryptBuffer, downloadPlainCdnBuffer } from './wechat/cdn/pic-decrypt'
import type { WeixinMessage, MessageItem } from './wechat/api/types'
import { MessageItemType } from './wechat/api/types'

const log = createLogger('WeChatAdapter')

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const DEFAULT_TIMEOUT_MS = 40_000
const QR_POLL_INTERVAL_MS = 2_000
const QR_EXPIRE_MS = 180_000
const RECONNECT_DELAY_MS = 5_000
const MAX_RECONNECT_DELAY_MS = 60_000

interface QRCodeResp {
  qrcode?: string
  qrcode_img_content?: string
}

interface QRStatusResp {
  status?: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  redirect_host?: string
}

/** 从 vendored 抛出的 Error.message 中尝试解析 errcode/ret */
function extractErrcode(err: unknown): number | undefined {
  if (!(err instanceof Error)) return
  const m = err.message.match(/"(?:errcode|ret)"\s*:\s*(-?\d+)/)
  return m ? Number(m[1]) : undefined
}

export class WeChatAdapter implements IMAdapter {
  readonly platform: IMPlatform = 'wechat'

  onMessage: ((msg: IMIncomingMessage) => void) | null = null
  onConnectionChange: ((connected: boolean) => void) | null = null

  private token: string = ''
  private baseUrl: string = FIXED_BASE_URL
  private connected = false
  private polling = false
  private getUpdatesBuf: string = ''
  private abortController: AbortController | null = null
  private reconnectDelay = RECONNECT_DELAY_MS
  private serverTimeoutMs = DEFAULT_TIMEOUT_MS

  private qrPollBaseUrl: string = FIXED_BASE_URL
  private loginAbort: AbortController | null = null

  /**
   * 上游 monitor.ts 在每条 inbound 上调 ConfigManager.getForUser(userId, msg.context_token)，
   * 既缓存 typing_ticket（24h TTL + 指数退避），又触发服务端 per-user 配置注册。
   * 没这一步，sendmessage 会被服务端持续以 errcode=-2 errmsg=unknown 拒掉。
   */
  private configManager: WeixinConfigManager | null = null
  private contextTokensRestored = false

  constructor(private config: WeChatConfig) {
    this.token = config.token || ''
    this.baseUrl = config.baseUrl || FIXED_BASE_URL
  }

  /** vendored session-guard 用 accountKey 隔离；token 前缀足够避免冲突，未登录则用占位符。 */
  private get accountKey(): string {
    return this.token ? `sf-wechat-${this.token.slice(0, 16)}` : 'sf-wechat-anon'
  }

  private get apiOpts(): WeixinApiOptions {
    return { baseUrl: this.baseUrl, token: this.token }
  }

  /** 获取/惰性创建 ConfigManager 单例（token/baseUrl 变化时重建）。 */
  private getConfigManager(): WeixinConfigManager {
    if (!this.configManager) {
      this.configManager = new WeixinConfigManager(
        { baseUrl: this.baseUrl, token: this.token },
        (msg) => log.debug(msg),
      )
    }
    return this.configManager
  }

  /**
   * 出站发消息时取最新 context_token：优先 store（持久化），缺省再用 replyContext 快照。
   * 上游所有 outbound 路径（channel.ts 的 sendText/sendMedia）都走 getContextToken。
   */
  private resolveContextToken(replyContext: { userId: string; contextToken?: string }): string | undefined {
    return getContextToken(this.accountKey, replyContext.userId) ?? replyContext.contextToken
  }

  /** 包裹 vendored 调用：先 assert 暂停期，捕获 -14 触发 pause，其它原样抛出。 */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    assertSessionActive(this.accountKey)
    try {
      return await fn()
    } catch (err) {
      if (extractErrcode(err) === SESSION_EXPIRED_ERRCODE) {
        pauseSession(this.accountKey)
      }
      throw err
    }
  }

  // ==================== QR 登录 ====================

  async login(): Promise<{ qrcodeUrl: string }> {
    this.cancelLogin()
    const abort = new AbortController()
    this.loginAbort = abort

    const raw = await apiGetFetch({
      baseUrl: FIXED_BASE_URL,
      endpoint: 'ilink/bot/get_bot_qrcode?bot_type=3',
      label: 'getBotQRCode',
    })
    const qr = JSON.parse(raw) as QRCodeResp
    if (!qr.qrcode || !qr.qrcode_img_content) {
      throw new Error('Failed to fetch QR code')
    }
    log.info('QR code fetched, polling status...')
    this.pollQRStatus(qr.qrcode, abort.signal)
    return { qrcodeUrl: qr.qrcode_img_content }
  }

  cancelLogin(): void {
    if (this.loginAbort) {
      this.loginAbort.abort()
      this.loginAbort = null
    }
  }

  private async pollQRStatus(qrcode: string, signal: AbortSignal): Promise<void> {
    this.qrPollBaseUrl = FIXED_BASE_URL
    const startTime = Date.now()

    while (!signal.aborted) {
      if (Date.now() - startTime > QR_EXPIRE_MS) {
        log.warn('QR code expired')
        this.onConnectionChange?.(false)
        return
      }

      let status: QRStatusResp
      try {
        const raw = await apiGetFetch({
          baseUrl: this.qrPollBaseUrl,
          endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
          label: 'getQRCodeStatus',
          timeoutMs: 35_000,
        })
        status = JSON.parse(raw) as QRStatusResp
      } catch (err: any) {
        if (signal.aborted) return
        if (err?.name === 'AbortError') {
          log.debug('QR status poll timeout, retrying...')
          continue
        }
        log.warn('QR status poll error, retrying...', err)
        await this.sleep(QR_POLL_INTERVAL_MS, signal)
        continue
      }

      if (signal.aborted) return

      switch (status.status) {
        case 'confirmed': {
          if (!status.bot_token) {
            log.error('QR confirmed but no bot_token received')
            this.onConnectionChange?.(false)
            return
          }
          this.token = status.bot_token
          this.baseUrl = status.baseurl || FIXED_BASE_URL
          log.info(`Login confirmed, botId=${status.ilink_bot_id || 'unknown'}`)
          this.loginAbort = null
          await this.startPolling()
          return
        }
        case 'expired':
          log.warn('QR code expired (server)')
          this.onConnectionChange?.(false)
          return
        case 'scaned':
          log.debug('QR scanned, waiting confirmation...')
          break
        case 'scaned_but_redirect': {
          if (status.redirect_host) {
            this.qrPollBaseUrl = `https://${status.redirect_host}`
            log.info(`IDC redirect, switching QR poll host to ${status.redirect_host}`)
          } else {
            log.warn('scaned_but_redirect but redirect_host is missing')
          }
          break
        }
        default:
          break
      }

      await this.sleep(QR_POLL_INTERVAL_MS, signal)
    }
  }

  // ==================== IMAdapter 接口 ====================

  async start(): Promise<void> {
    if (!this.token) {
      throw new Error('No token available. Please login first.')
    }
    await this.startPolling()
  }

  async stop(): Promise<void> {
    this.cancelLogin()
    this.stopPolling()
    this.connected = false
    this.onConnectionChange?.(false)
    // 与上游 channel.ts 的 stopAccount 对齐：通知服务端"客户端下线"，失败仅 warn。
    if (this.token) {
      try {
        const resp = await vendoredNotifyStop(this.apiOpts)
        if (resp.ret !== undefined && resp.ret !== 0) {
          log.warn(`notifyStop: ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`)
        }
      } catch (err) {
        log.warn(`notifyStop failed during shutdown (ignored): ${String(err)}`)
      }
    }
    log.info('Stopped')
  }

  isConnected(): boolean {
    return this.connected
  }

  getCredentials(): { token: string; baseUrl: string } {
    return { token: this.token, baseUrl: this.baseUrl }
  }

  async sendText(replyContext: any, text: string): Promise<void> {
    const ctx = replyContext as { userId: string; contextToken?: string }
    const contextToken = this.resolveContextToken(ctx)
    const truncated = text.length > IM_TEXT_MAX_LENGTH
      ? text.substring(0, IM_TEXT_MAX_LENGTH - 20) + '\n...(已截断)'
      : text
    await this.guarded(() => sendMessageWeixin({
      to: ctx.userId,
      text: truncated,
      opts: { ...this.apiOpts, contextToken },
    }))
  }

  async sendMarkdown(replyContext: any, _title: string, content: string): Promise<void> {
    await this.sendText(replyContext, content)
  }

  async sendImage(replyContext: any, filePath: string): Promise<void> {
    const ctx = replyContext as { userId: string; contextToken?: string }
    const contextToken = this.resolveContextToken(ctx)
    log.info(`sendImage: file=${path.basename(filePath)} userId=${ctx.userId} hasToken=${!!contextToken}`)
    await this.guarded(() => sendWeixinMediaFile({
      filePath,
      to: ctx.userId,
      text: '',
      opts: { ...this.apiOpts, contextToken },
      cdnBaseUrl: CDN_BASE_URL,
    }))
  }

  async sendFile(replyContext: any, filePath: string, fileName?: string): Promise<void> {
    const ctx = replyContext as { userId: string; contextToken?: string }
    const contextToken = this.resolveContextToken(ctx)
    log.info(`sendFile: file=${fileName || path.basename(filePath)} userId=${ctx.userId} hasToken=${!!contextToken}`)
    await this.guarded(() => sendWeixinMediaFile({
      filePath,
      to: ctx.userId,
      text: '',
      opts: { ...this.apiOpts, contextToken },
      cdnBaseUrl: CDN_BASE_URL,
    }))
  }

  // ==================== 长轮询 ====================

  private async startPolling(): Promise<void> {
    if (this.polling) return
    this.polling = true
    this.abortController = new AbortController()
    this.reconnectDelay = RECONNECT_DELAY_MS

    // 上游 channel.ts 的 startAccount 顺序：restoreContextTokens → setStatus → notifyStart → monitor。
    // restoreContextTokens 把磁盘上的 contextTokenStore 加载回内存（重启后还能 proactive 推送），
    // notifyStart 通知服务端"客户端上线"——没这步 sendmessage 一律 errcode=-2。
    if (!this.contextTokensRestored) {
      try {
        restoreContextTokens(this.accountKey)
      } catch (err) {
        log.warn(`restoreContextTokens failed (ignored): ${String(err)}`)
      }
      this.contextTokensRestored = true
    }

    try {
      const resp = await vendoredNotifyStart(this.apiOpts)
      if (resp.ret !== undefined && resp.ret !== 0) {
        log.warn(`notifyStart: ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`)
      }
    } catch (err) {
      // 上游 startAccount 也是 warn 不抛——失败 polling 仍然可继续，但 sendmessage 大概率会失败
      log.warn(`notifyStart failed during startup (ignored): ${String(err)}`)
    }

    this.setConnected(true)
    this.pollLoop(this.abortController.signal)
  }

  private stopPolling(): void {
    this.polling = false
    this.abortController?.abort()
    this.abortController = null
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (this.polling && !signal.aborted) {
      try {
        assertSessionActive(this.accountKey)
        const resp = await vendoredGetUpdates({
          baseUrl: this.baseUrl,
          token: this.token,
          get_updates_buf: this.getUpdatesBuf,
          timeoutMs: this.serverTimeoutMs,
        })
        if (signal.aborted) break

        const code = resp.ret ?? resp.errcode
        if (code === SESSION_EXPIRED_ERRCODE) {
          log.warn('Session expired, pausing for 1h and stopping poll loop')
          pauseSession(this.accountKey)
          this.setConnected(false)
          this.polling = false
          break
        }
        if (code !== undefined && code !== 0) {
          log.warn(`getUpdates error: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg || ''}`)
          await this.reconnectBackoff(signal)
          continue
        }

        this.reconnectDelay = RECONNECT_DELAY_MS
        if (!this.connected) this.setConnected(true)

        if (resp.get_updates_buf) {
          this.getUpdatesBuf = resp.get_updates_buf
        }
        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
          this.serverTimeoutMs = resp.longpolling_timeout_ms + 5_000
        }

        if (resp.msgs?.length) {
          for (const msg of resp.msgs) {
            await this.handleMessage(msg)
          }
        }
      } catch (err: any) {
        if (signal.aborted) break
        if (extractErrcode(err) === SESSION_EXPIRED_ERRCODE) {
          pauseSession(this.accountKey)
          this.setConnected(false)
          this.polling = false
          break
        }
        log.error('Poll error:', err)
        if (this.connected) this.setConnected(false)
        await this.reconnectBackoff(signal)
      }
    }
  }

  // ==================== 消息分发 ====================

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    const userId = msg.from_user_id || ''
    if (!userId) return

    // 与上游 monitor.ts + process-message.ts 对齐：每条 inbound 都要做两件事，
    // 不做 sendmessage 一律会被服务端拒掉（errcode=-2）。
    //   1. setContextToken：把 token 写进 store + 持久化到磁盘
    //   2. ConfigManager.getForUser：触发 getconfig 注册 user 端会话 + 缓存 typing_ticket
    if (msg.context_token) {
      try {
        setContextToken(this.accountKey, userId, msg.context_token)
      } catch (err) {
        log.warn(`setContextToken failed (ignored): ${String(err)}`)
      }
    }
    try {
      // 不 await 失败：configManager 内部有重试与退避，发不出去也不阻断这条消息
      void this.getConfigManager().getForUser(userId, msg.context_token)
    } catch (err) {
      log.warn(`configManager.getForUser threw (ignored): ${String(err)}`)
    }

    const text = extractTextFromItems(msg.item_list)
    const attachments = await this.downloadAttachments(msg.item_list)

    if (!text && attachments.length === 0) {
      log.debug(`Skipping empty message from ${userId}`)
      return
    }

    const incoming: IMIncomingMessage = {
      platform: 'wechat',
      userId,
      userName: (msg as any).from_user_name || userId,
      text,
      chatType: 'single',
      replyContext: {
        userId,
        // 仅作 fallback 种子；实际发送时 resolveContextToken 优先取 store 里的最新值
        contextToken: msg.context_token,
      },
      ...(attachments.length > 0 ? { attachments } : {}),
    }

    try {
      this.onMessage?.(incoming)
    } catch (err) {
      log.error('onMessage handler error:', err)
    }
  }

  // ==================== 附件下载 ====================

  private ensureTempDir(): string {
    const dir = path.join(os.tmpdir(), 'sf-terminal-im', 'wechat')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  private async downloadAttachments(items?: MessageItem[]): Promise<IMAttachment[]> {
    if (!items?.length) return []

    const hasMedia = (m: any) => m?.encrypt_query_param || m?.full_url
    const target =
      items.find(i => i.type === MessageItemType.IMAGE && hasMedia(i.image_item?.media))
      ?? items.find(i => i.type === MessageItemType.VIDEO && hasMedia(i.video_item?.media))
      ?? items.find(i => i.type === MessageItemType.FILE && hasMedia(i.file_item?.media))
      ?? items.find(i => i.type === MessageItemType.VOICE && hasMedia(i.voice_item?.media) && !i.voice_item?.text)

    if (!target) return []

    try {
      const att = await this.downloadOneItem(target)
      return att ? [att] : []
    } catch (err) {
      log.error(`Media download failed (type=${target.type}):`, err)
      return []
    }
  }

  private async downloadOneItem(item: MessageItem): Promise<IMAttachment | null> {
    const timestamp = Date.now()
    const tempDir = this.ensureTempDir()

    // vendored downloadAndDecryptBuffer / downloadPlainCdnBuffer 用位置参数：
    //   (encryptedQueryParam, [aesKeyBase64], cdnBaseUrl, label, fullUrl?)
    // 之前误用对象参数，全部 attachment 下载都直接走到 catch 被静默吞掉。
    const fetchBuf = async (media: any, aeskeyHex?: string): Promise<Buffer> => {
      const aesKeyBase64: string | undefined = aeskeyHex
        ? Buffer.from(aeskeyHex, 'hex').toString('base64')
        : media?.aes_key
      const encryptedQueryParam: string = media?.encrypt_query_param ?? ''
      const fullUrl: string | undefined = media?.full_url
      if (aesKeyBase64) {
        return await downloadAndDecryptBuffer(
          encryptedQueryParam,
          aesKeyBase64,
          CDN_BASE_URL,
          'wechat-attachment',
          fullUrl,
        )
      }
      return await downloadPlainCdnBuffer(
        encryptedQueryParam,
        CDN_BASE_URL,
        'wechat-attachment',
        fullUrl,
      )
    }

    if (item.type === MessageItemType.IMAGE) {
      const img = item.image_item
      if (!img?.media) return null
      const buf = await fetchBuf(img.media, (img as any).aeskey)
      const fileName = `wechat_image_${timestamp}.jpg`
      const localPath = path.join(tempDir, fileName)
      fs.writeFileSync(localPath, buf)
      log.info(`Image saved: ${localPath} (${(buf.length / 1024).toFixed(1)}KB)`)
      return { type: 'image', localPath, fileName }
    }
    if (item.type === MessageItemType.VIDEO) {
      const v = item.video_item
      if (!v?.media?.aes_key) return null
      const buf = await fetchBuf(v.media)
      const fileName = `wechat_video_${timestamp}.mp4`
      const localPath = path.join(tempDir, fileName)
      fs.writeFileSync(localPath, buf)
      log.info(`Video saved: ${localPath} (${(buf.length / 1024).toFixed(1)}KB)`)
      return { type: 'video', localPath, fileName }
    }
    if (item.type === MessageItemType.FILE) {
      const f = item.file_item
      if (!f?.media?.aes_key) return null
      const buf = await fetchBuf(f.media)
      const fileName = (f as any).file_name || `wechat_file_${timestamp}`
      const localPath = path.join(tempDir, fileName)
      fs.writeFileSync(localPath, buf)
      log.info(`File saved: ${localPath} (${(buf.length / 1024).toFixed(1)}KB)`)
      return { type: 'file', localPath, fileName }
    }
    if (item.type === MessageItemType.VOICE) {
      const voice = item.voice_item
      if (!voice?.media?.aes_key) return null
      const buf = await fetchBuf(voice.media)
      const fileName = `wechat_voice_${timestamp}.silk`
      const localPath = path.join(tempDir, fileName)
      fs.writeFileSync(localPath, buf)
      log.info(`Voice saved: ${localPath} (${(buf.length / 1024).toFixed(1)}KB)`)
      return { type: 'audio', localPath, fileName }
    }
    return null
  }

  // ==================== 工具方法 ====================

  private setConnected(value: boolean): void {
    if (this.connected === value) return
    this.connected = value
    this.onConnectionChange?.(value)
  }

  private async reconnectBackoff(signal: AbortSignal): Promise<void> {
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS)
    log.info(`Reconnecting in ${delay}ms...`)
    await this.sleep(delay, signal)
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) { resolve(); return }
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }
}

function extractTextFromItems(items?: MessageItem[]): string {
  if (!items?.length) return ''
  const parts: string[] = []
  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      parts.push(item.text_item.text)
    } else if (item.type === MessageItemType.VOICE && (item.voice_item as any)?.text) {
      parts.push((item.voice_item as any).text)
    } else if (item.type === MessageItemType.REF_MSG && (item as any).ref_msg) {
      const ref = (item as any).ref_msg
      const refText = ref.message_item?.text_item?.text
      if (refText) parts.push(`[引用: ${refText}]`)
    }
  }
  return parts.join('\n')
}
