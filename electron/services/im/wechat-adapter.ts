/**
 * WeChat Adapter — 基于微信 OpenClaw 官方协议的 IM 适配器
 *
 * 协议实现参考 @tencent-weixin/openclaw-weixin 源码（MIT），
 * 但不依赖该包，自主实现 HTTP API 调用层。
 *
 * 核心流程：
 *   扫码登录 → 获取 token → getUpdates 长轮询收消息 → sendMessage 发消息
 *
 * API 端点：
 *   - QR 登录：GET /ilink/bot/get_bot_qrcode, GET /ilink/bot/get_qrcode_status
 *   - 消息：POST /ilink/bot/getupdates, POST /ilink/bot/sendmessage
 *   - 输入状态：POST /ilink/bot/sendtyping
 */

import crypto, { createCipheriv, createDecipheriv } from 'node:crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { IMAdapter, IMIncomingMessage, IMPlatform, WeChatConfig, IMAttachment } from './types'
import { IM_TEXT_MAX_LENGTH } from './types'
import { createLogger } from '../../utils/logger'

const log = createLogger('WeChatAdapter')

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
const DEFAULT_TIMEOUT_MS = 40_000
const QR_POLL_INTERVAL_MS = 2_000
const QR_EXPIRE_MS = 180_000
const RECONNECT_DELAY_MS = 5_000
const MAX_RECONNECT_DELAY_MS = 60_000
const SESSION_TIMEOUT_CODE = -14

// ==================== 协议类型 ====================

interface BaseInfo {
  channel_version?: string
}

const enum MessageItemType {
  TEXT = 1,
  IMAGE = 2,
  VOICE = 3,
  FILE = 4,
  VIDEO = 5,
}

const enum MessageType {
  USER = 1,
  BOT = 2,
}

const enum MessageState {
  GENERATING = 1,
  FINISH = 2,
}

interface CDNMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

interface TextItem { text?: string }
interface RefMsg { title?: string; message_item?: MessageItem }

interface ImageItem {
  media?: CDNMedia
  thumb_media?: CDNMedia
  aeskey?: string
  mid_size?: number
}

interface VoiceItem {
  media?: CDNMedia
  text?: string
}

interface FileItem {
  media?: CDNMedia
  file_name?: string
  len?: string
}

interface VideoItem {
  media?: CDNMedia
  video_size?: number
}

interface MessageItem {
  type?: MessageItemType
  text_item?: TextItem
  image_item?: ImageItem
  video_item?: VideoItem
  file_item?: FileItem
  voice_item?: VoiceItem
  ref_msg?: RefMsg
}

interface WeixinMessage {
  from_user_id?: string
  from_user_name?: string
  to_user_id?: string
  item_list?: MessageItem[]
  context_token?: string
  create_time_ms?: number
}

interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

interface QRCodeResp {
  qrcode: string
  qrcode_img_content: string
}

interface QRStatusResp {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

// ==================== HTTP 工具 ====================

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

function buildHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'Authorization': `Bearer ${token}`,
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': '1',
  }
}

function checkApiError(data: any, context: string): void {
  const code = data?.errcode ?? data?.ret
  if (code != null && code !== 0) {
    throw new Error(`${context}: errcode=${code} errmsg=${data?.errmsg || 'unknown'}`)
  }
}

async function apiPost<T>(baseUrl: string, apiPath: string, token: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const url = `${baseUrl}${apiPath}`
  const jsonBody = JSON.stringify(body)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        ...buildHeaders(token),
        'Content-Length': String(Buffer.byteLength(jsonBody)),
      },
      body: jsonBody,
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
    const data = await resp.json() as T
    checkApiError(data, apiPath)
    return data
  } finally {
    clearTimeout(timer)
  }
}

const COMMON_HEADERS: Record<string, string> = {
  'iLink-App-Id': 'bot',
  'iLink-App-ClientVersion': '1',
}

async function apiGet<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { headers: COMMON_HEADERS, signal: controller.signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
    return await resp.json() as T
  } finally {
    clearTimeout(timer)
  }
}

// ==================== CDN 常量 & 加解密 ====================

const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const MEDIA_MAX_BYTES = 20 * 1024 * 1024
const CDN_UPLOAD_MAX_RETRIES = 3

const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const

interface ApiResponse {
  ret?: number
  errcode?: number
  errmsg?: string
}

interface GetUploadUrlResp extends ApiResponse {
  upload_param?: string
  upload_full_url?: string
}

/**
 * 解析 CDNMedia.aes_key → 原始 16 字节 AES 密钥
 * 两种编码：base64(raw 16 bytes) 或 base64(hex string 32 chars)
 */
function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`)
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

function buildCdnDownloadUrl(encryptQueryParam: string): string {
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`
}

function buildCdnUploadUrl(uploadParam: string, filekey: string): string {
  return `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

async function downloadAndDecrypt(media: CDNMedia, hexAesKey?: string): Promise<Buffer> {
  const aesKeyBase64 = hexAesKey
    ? Buffer.from(hexAesKey, 'hex').toString('base64')
    : media.aes_key
  if (!aesKeyBase64) throw new Error('No AES key available for media decryption')

  const url = media.full_url || (media.encrypt_query_param ? buildCdnDownloadUrl(media.encrypt_query_param) : '')
  if (!url) throw new Error('No download URL available')

  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`CDN download ${resp.status} ${resp.statusText}`)
  const encrypted = Buffer.from(await resp.arrayBuffer())

  if (encrypted.length > MEDIA_MAX_BYTES) {
    throw new Error(`Media too large: ${(encrypted.length / 1024 / 1024).toFixed(1)}MB`)
  }

  const key = parseAesKey(aesKeyBase64)
  return decryptAesEcb(encrypted, key)
}

async function downloadPlain(media: CDNMedia): Promise<Buffer> {
  const url = media.full_url || (media.encrypt_query_param ? buildCdnDownloadUrl(media.encrypt_query_param) : '')
  if (!url) throw new Error('No download URL available')

  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`CDN download ${resp.status} ${resp.statusText}`)
  const buf = Buffer.from(await resp.arrayBuffer())

  if (buf.length > MEDIA_MAX_BYTES) {
    throw new Error(`Media too large: ${(buf.length / 1024 / 1024).toFixed(1)}MB`)
  }
  return buf
}

// ==================== 消息解析 ====================

function isMediaItem(item: MessageItem): boolean {
  return item.type === MessageItemType.IMAGE
    || item.type === MessageItemType.VIDEO
    || item.type === MessageItemType.FILE
    || item.type === MessageItemType.VOICE
}

function extractTextFromItems(items?: MessageItem[]): string {
  if (!items?.length) return ''
  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text)
      const ref = item.ref_msg
      if (!ref) return text
      if (ref.message_item && isMediaItem(ref.message_item)) return text
      const parts: string[] = []
      if (ref.title) parts.push(ref.title)
      if (ref.message_item) {
        const refBody = extractTextFromItems([ref.message_item])
        if (refBody) parts.push(refBody)
      }
      if (!parts.length) return text
      return `[引用: ${parts.join(' | ')}]\n${text}`
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text
    }
  }
  return ''
}

// ==================== WeChat Adapter ====================

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
  /** context_token 缓存：userId → contextToken（回复时必须携带） */
  private contextTokens = new Map<string, string>()
  private static readonly MAX_CONTEXT_TOKENS = 100
  /** 服务端建议的长轮询超时（ms），从 getUpdates 响应中动态更新 */
  private serverTimeoutMs = DEFAULT_TIMEOUT_MS

  /** QR 轮询使用的 base URL（IDC 重定向时会切换） */
  private qrPollBaseUrl: string = FIXED_BASE_URL
  /** 正在进行的 QR 登录会话 */
  private loginAbort: AbortController | null = null

  constructor(private config: WeChatConfig) {
    this.token = config.token || ''
    this.baseUrl = config.baseUrl || FIXED_BASE_URL
  }

  // ==================== QR 登录 ====================

  /**
   * 发起扫码登录。返回 QR 码内容 URL（需前端生成 QR 图或在浏览器打开）。
   * 内部会自动轮询扫码状态，登录成功后触发 onConnectionChange(true)。
   *
   * @returns qrcodeUrl 二维码内容（URL 字符串，前端可用来生成 QR 图片）
   */
  async login(): Promise<{ qrcodeUrl: string }> {
    this.cancelLogin()
    const abort = new AbortController()
    this.loginAbort = abort

    const qr = await apiGet<QRCodeResp>(
      `${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`
    )
    if (!qr.qrcode || !qr.qrcode_img_content) {
      throw new Error('Failed to fetch QR code')
    }

    const qrcodeUrl = qr.qrcode_img_content
    log.info(`QR code fetched, polling status...`)

    // 后台轮询扫码状态
    this.pollQRStatus(qr.qrcode, abort.signal)

    return { qrcodeUrl }
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
        status = await apiGet<QRStatusResp>(
          `${this.qrPollBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
        )
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
          const redirectHost = status.redirect_host
          if (redirectHost) {
            this.qrPollBaseUrl = `https://${redirectHost}`
            log.info(`IDC redirect, switching QR poll host to ${redirectHost}`)
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
    log.info('Stopped')
  }

  isConnected(): boolean {
    return this.connected
  }

  /** 获取当前凭证（供外部持久化） */
  getCredentials(): { token: string; baseUrl: string } {
    return { token: this.token, baseUrl: this.baseUrl }
  }

  async sendText(replyContext: any, text: string): Promise<void> {
    const { userId, contextToken } = replyContext as { userId: string; contextToken?: string }
    const token = contextToken || this.contextTokens.get(userId)
    if (!token) {
      log.warn(`sendText: no contextToken for user ${userId}, message may fail`)
    }
    const truncated = text.length > IM_TEXT_MAX_LENGTH
      ? text.substring(0, IM_TEXT_MAX_LENGTH - 20) + '\n...(已截断)'
      : text
    await this.sendMessageApi(userId, truncated, token)
  }

  async sendMarkdown(replyContext: any, _title: string, content: string): Promise<void> {
    await this.sendText(replyContext, content)
  }

  async sendImage(replyContext: any, filePath: string): Promise<void> {
    const { userId, contextToken } = replyContext as { userId: string; contextToken?: string }
    const token = contextToken || this.contextTokens.get(userId)

    log.info(`sendImage: file=${filePath} userId=${userId} hasToken=${!!token}`)
    const uploaded = await this.uploadMedia(filePath, userId, UploadMediaType.IMAGE)
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: userId,
        client_id: `sf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{
          type: MessageItemType.IMAGE,
          image_item: {
            media: {
              encrypt_query_param: uploaded.downloadParam,
              aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
              encrypt_type: 1,
            },
            mid_size: uploaded.ciphertextSize,
          },
        }],
        context_token: token || undefined,
      },
      base_info: { channel_version: '1.0' } as BaseInfo,
    }
    await apiPost(this.baseUrl, '/ilink/bot/sendmessage', this.token, body)
    log.info(`sendImage: success file=${path.basename(filePath)}`)
  }

  async sendFile(replyContext: any, filePath: string, fileName?: string): Promise<void> {
    const { userId, contextToken } = replyContext as { userId: string; contextToken?: string }
    const token = contextToken || this.contextTokens.get(userId)
    const name = fileName || path.basename(filePath)

    const ext = path.extname(filePath).toLowerCase()
    const isVideo = ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)
    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)

    const mediaType = isVideo ? UploadMediaType.VIDEO
      : isImage ? UploadMediaType.IMAGE
      : UploadMediaType.FILE

    log.info(`sendFile: file=${name} userId=${userId} mediaType=${mediaType} hasToken=${!!token}`)
    const uploaded = await this.uploadMedia(filePath, userId, mediaType)
    const clientId = `sf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const cdnMedia: CDNMedia = {
      encrypt_query_param: uploaded.downloadParam,
      aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
      encrypt_type: 1,
    }

    let itemList: MessageItem[]
    if (isVideo) {
      itemList = [{ type: MessageItemType.VIDEO, video_item: { media: cdnMedia, video_size: uploaded.ciphertextSize } }]
    } else if (isImage) {
      itemList = [{ type: MessageItemType.IMAGE, image_item: { media: cdnMedia, mid_size: uploaded.ciphertextSize } }]
    } else {
      itemList = [{ type: MessageItemType.FILE, file_item: { media: cdnMedia, file_name: name, len: String(uploaded.plaintextSize) } }]
    }

    const body = {
      msg: {
        from_user_id: '',
        to_user_id: userId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: itemList,
        context_token: token || undefined,
      },
      base_info: { channel_version: '1.0' } as BaseInfo,
    }
    await apiPost(this.baseUrl, '/ilink/bot/sendmessage', this.token, body)
    log.info(`sendFile: success file=${name}`)
  }

  // ==================== 长轮询 ====================

  private async startPolling(): Promise<void> {
    if (this.polling) return
    this.polling = true
    this.abortController = new AbortController()
    this.reconnectDelay = RECONNECT_DELAY_MS

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
        const resp = await this.getUpdates(signal)
        if (signal.aborted) break

        const isSessionExpired =
          resp.ret === SESSION_TIMEOUT_CODE || resp.errcode === SESSION_TIMEOUT_CODE
        if (isSessionExpired) {
          log.warn('Session expired, stopping...')
          this.setConnected(false)
          this.polling = false
          break
        }

        const isApiError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0)
        if (isApiError) {
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
        log.error('Poll error:', err)
        if (this.connected) this.setConnected(false)
        await this.reconnectBackoff(signal)
      }
    }
  }

  private async getUpdates(signal: AbortSignal): Promise<GetUpdatesResp> {
    const body = {
      get_updates_buf: this.getUpdatesBuf,
      base_info: { channel_version: '1.0' } as BaseInfo,
    }
    const jsonBody = JSON.stringify(body)
    const url = `${this.baseUrl}/ilink/bot/getupdates`
    const controller = new AbortController()

    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), this.serverTimeoutMs)

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          ...buildHeaders(this.token),
          'Content-Length': String(Buffer.byteLength(jsonBody)),
        },
        body: jsonBody,
        signal: controller.signal,
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
      const rawText = await resp.text()
      const parsed = JSON.parse(rawText) as GetUpdatesResp
      log.debug(`getUpdates: ret=${parsed.ret} errcode=${parsed.errcode} msgs=${parsed.msgs?.length ?? 0} buf_len=${parsed.get_updates_buf?.length ?? 0}`)
      return parsed
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        // 长轮询超时是正常行为，返回空结果让调用方重试
        return { ret: 0, msgs: [], get_updates_buf: this.getUpdatesBuf }
      }
      throw err
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  // ==================== 发送消息 ====================

  private async sendMessageApi(toUserId: string, text: string, contextToken?: string): Promise<void> {
    const clientId = `sf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const itemList: MessageItem[] = text
      ? [{ type: MessageItemType.TEXT, text_item: { text } }]
      : []
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: itemList.length ? itemList : undefined,
        context_token: contextToken || undefined,
      },
      base_info: { channel_version: '1.0' } as BaseInfo,
    }

    await apiPost(this.baseUrl, '/ilink/bot/sendmessage', this.token, body)
  }

  // ==================== CDN 上传 ====================

  private async uploadMedia(
    filePath: string,
    toUserId: string,
    mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType],
  ): Promise<{ downloadParam: string; aeskey: string; plaintextSize: number; ciphertextSize: number }> {
    const plaintext = fs.readFileSync(filePath)
    const rawsize = plaintext.length
    const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex')
    const filesize = aesEcbPaddedSize(rawsize)
    const filekey = crypto.randomBytes(16).toString('hex')
    const aeskey = crypto.randomBytes(16)

    log.info(`uploadMedia: file=${path.basename(filePath)} rawsize=${rawsize} filesize=${filesize} type=${mediaType}`)

    const uploadUrlResp = await apiPost<GetUploadUrlResp>(
      this.baseUrl, '/ilink/bot/getuploadurl', this.token,
      {
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey: aeskey.toString('hex'),
        base_info: { channel_version: '1.0' } as BaseInfo,
      },
    )

    const uploadFullUrl = uploadUrlResp.upload_full_url?.trim()
    const uploadParam = uploadUrlResp.upload_param
    if (!uploadFullUrl && !uploadParam) {
      throw new Error('getUploadUrl returned no upload URL')
    }

    const ciphertext = encryptAesEcb(plaintext, aeskey)
    const cdnUrl = uploadFullUrl || buildCdnUploadUrl(uploadParam!, filekey)

    const downloadParam = await this.uploadToCdn(cdnUrl, ciphertext)

    log.info(`uploadMedia: success filekey=${filekey} size=${rawsize}→${ciphertext.length}`)
    return {
      downloadParam,
      aeskey: aeskey.toString('hex'),
      plaintextSize: rawsize,
      ciphertextSize: filesize,
    }
  }

  private async uploadToCdn(cdnUrl: string, ciphertext: Buffer): Promise<string> {
    let downloadParam: string | undefined
    let lastError: unknown

    for (let attempt = 1; attempt <= CDN_UPLOAD_MAX_RETRIES; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60_000)
      try {
        const res = await fetch(cdnUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
          signal: controller.signal,
        })
        if (res.status >= 400 && res.status < 500) {
          const errMsg = res.headers.get('x-error-message') ?? await res.text()
          throw new Error(`CDN upload client error ${res.status}: ${errMsg}`)
        }
        if (res.status !== 200) {
          throw new Error(`CDN upload server error ${res.status}`)
        }
        downloadParam = res.headers.get('x-encrypted-param') ?? undefined
        if (!downloadParam) {
          throw new Error('CDN response missing x-encrypted-param header')
        }
        break
      } catch (err) {
        lastError = err
        if (err instanceof Error && err.message.includes('client error')) throw err
        if (attempt < CDN_UPLOAD_MAX_RETRIES) {
          log.warn(`CDN upload attempt ${attempt} failed, retrying...`)
        }
      } finally {
        clearTimeout(timer)
      }
    }

    if (!downloadParam) {
      throw lastError instanceof Error ? lastError : new Error('CDN upload failed')
    }
    return downloadParam
  }

  // ==================== 消息分发 ====================

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    const userId = msg.from_user_id || ''
    if (!userId) return

    if (msg.context_token) {
      this.contextTokens.set(userId, msg.context_token)
      if (this.contextTokens.size > WeChatAdapter.MAX_CONTEXT_TOKENS) {
        const first = this.contextTokens.keys().next().value
        if (first) this.contextTokens.delete(first)
      }
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
      userName: msg.from_user_name || userId,
      text,
      chatType: 'single',
      replyContext: {
        userId,
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

  // ==================== 媒体下载 ====================

  private ensureTempDir(): string {
    const dir = path.join(os.tmpdir(), 'sf-terminal-im', 'wechat')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * 查找消息中的可下载媒体项，下载解密后返回 IMAttachment 列表。
   * 优先级：IMAGE > VIDEO > FILE > VOICE（无转文字的语音）
   */
  private async downloadAttachments(items?: MessageItem[]): Promise<IMAttachment[]> {
    if (!items?.length) return []

    const hasMedia = (m?: CDNMedia) => m?.encrypt_query_param || m?.full_url
    const mediaItem =
      items.find(i => i.type === MessageItemType.IMAGE && hasMedia(i.image_item?.media))
      ?? items.find(i => i.type === MessageItemType.VIDEO && hasMedia(i.video_item?.media))
      ?? items.find(i => i.type === MessageItemType.FILE && hasMedia(i.file_item?.media))
      ?? items.find(i => i.type === MessageItemType.VOICE && hasMedia(i.voice_item?.media) && !i.voice_item?.text)

    if (!mediaItem) return []

    try {
      const attachment = await this.downloadOneItem(mediaItem)
      return attachment ? [attachment] : []
    } catch (err) {
      log.error(`Media download failed (type=${mediaItem.type}):`, err)
      return []
    }
  }

  private async downloadOneItem(item: MessageItem): Promise<IMAttachment | null> {
    const timestamp = Date.now()
    const tempDir = this.ensureTempDir()

    if (item.type === MessageItemType.IMAGE) {
      const img = item.image_item
      if (!img?.media) return null
      const buf = img.aeskey || img.media.aes_key
        ? await downloadAndDecrypt(img.media, img.aeskey)
        : await downloadPlain(img.media)
      const fileName = `wechat_image_${timestamp}.jpg`
      const localPath = path.join(tempDir, fileName)
      fs.writeFileSync(localPath, buf)
      log.info(`Image saved: ${localPath} (${(buf.length / 1024).toFixed(1)}KB)`)
      return { type: 'image', localPath, fileName }
    }

    if (item.type === MessageItemType.VIDEO) {
      const video = item.video_item
      if (!video?.media?.aes_key) return null
      const buf = await downloadAndDecrypt(video.media)
      const fileName = `wechat_video_${timestamp}.mp4`
      const localPath = path.join(tempDir, fileName)
      fs.writeFileSync(localPath, buf)
      log.info(`Video saved: ${localPath} (${(buf.length / 1024).toFixed(1)}KB)`)
      return { type: 'video', localPath, fileName }
    }

    if (item.type === MessageItemType.FILE) {
      const file = item.file_item
      if (!file?.media?.aes_key) return null
      const buf = await downloadAndDecrypt(file.media)
      const fileName = file.file_name || `wechat_file_${timestamp}`
      const localPath = path.join(tempDir, fileName)
      fs.writeFileSync(localPath, buf)
      log.info(`File saved: ${localPath} (${(buf.length / 1024).toFixed(1)}KB)`)
      return { type: 'file', localPath, fileName }
    }

    if (item.type === MessageItemType.VOICE) {
      const voice = item.voice_item
      if (!voice?.media?.aes_key) return null
      const buf = await downloadAndDecrypt(voice.media)
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
