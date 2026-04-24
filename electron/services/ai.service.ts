import { ConfigService } from './config.service'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import * as https from 'https'
import * as http from 'http'
import { t } from './agent/i18n'
import { getAiDebugService } from './ai-debug.service'
import type { ProviderChatParams } from './plugin/types'
import { createLogger } from '../utils/logger'

const log = createLogger('AI')

// AI 请求超时配置（毫秒）
const AI_TIMEOUT = {
  CONNECT: 30 * 1000,        // 连接超时：30 秒（火山引擎等中转服务需要更长连接时间）
  SOCKET_IDLE: 120 * 1000,   // 空闲超时：120 秒（流式请求中数据流中断检测）
  TOTAL: 10 * 60 * 1000      // 总超时：10 分钟（长文本生成可能需要较长时间）
}

// 网络错误自动重试配置
const AI_RETRY = {
  MAX_RETRIES: 3,            // 网络错误最大重试次数
  BASE_DELAY: 2000,          // 网络错误基础退避：2 秒
  RATE_LIMIT_MAX_RETRIES: 5, // Rate limit 最大重试次数
  RATE_LIMIT_BASE_DELAY: 5000, // Rate limit 基础退避：5 秒
  SERVER_ERROR_MAX_RETRIES: 3, // 5xx 服务端错误最大重试次数
  SERVER_ERROR_BASE_DELAY: 3000, // 5xx 基础退避：3 秒
  JITTER_FACTOR: 0.2,        // 退避抖动因子（±20%），避免 thundering herd
  // Node.js 网络错误码（稳定常量，非关键词匹配）
  RETRYABLE_ERRORS: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'socket hang up'],
  // 可重试的 HTTP 状态码（服务端临时错误）
  RETRYABLE_STATUS_CODES: [500, 502, 503, 529] as readonly number[]
}

function isRetryableError(errorMessage: string): boolean {
  return AI_RETRY.RETRYABLE_ERRORS.some(code => errorMessage.includes(code))
}

function isRetryableStatusCode(statusCode: number): boolean {
  return statusCode === 429 || AI_RETRY.RETRYABLE_STATUS_CODES.includes(statusCode)
}

/**
 * 计算带 jitter 的指数退避延迟
 * delay = baseDelay * 2^attempt * (1 ± jitterFactor)
 */
function calculateBackoff(baseDelay: number, attempt: number): number {
  const expDelay = baseDelay * Math.pow(2, attempt)
  const jitter = expDelay * AI_RETRY.JITTER_FACTOR * (2 * Math.random() - 1)
  return Math.max(0, Math.round(expDelay + jitter))
}

/**
 * AI API 请求错误分类
 */
interface ApiRequestError extends Error {
  statusCode?: number
  retryAfter?: number
  apiErrorCode?: string
}

function toApiRequestError(err: unknown, statusCode?: number, headers?: Record<string, string | string[] | undefined>, apiErrorCode?: string): ApiRequestError {
  const error = (err instanceof Error ? err : new Error(String(err))) as ApiRequestError
  error.statusCode = statusCode
  error.apiErrorCode = apiErrorCode
  if (statusCode === 429 && headers?.['retry-after']) {
    const raw = String(headers['retry-after'])
    const seconds = Number(raw)
    if (!isNaN(seconds) && seconds > 0) {
      error.retryAfter = seconds * 1000
    } else {
      const date = Date.parse(raw)
      if (!isNaN(date)) {
        error.retryAfter = Math.max(1000, date - Date.now())
      }
    }
  }
  return error
}

/**
 * 通用 AI API 重试包装器
 * 对 Promise 类请求（chat / chatWithTools / makeRequest）提供统一的重试策略：
 * - 网络错误：指数退避 + jitter
 * - 429 Rate Limit：优先 Retry-After，否则指数退避
 * - 5xx 服务端错误：指数退避
 * - context_length_exceeded / 其他 4xx：不重试
 */
async function withApiRetry<T>(
  fn: () => Promise<T>,
  options?: {
    /** 覆盖网络错误最大重试次数 */
    maxRetries?: number
    /** 不重试的错误码 */
    noRetryErrorCodes?: string[]
    /** 重试前回调 */
    onRetry?: (attempt: number, delay: number, reason: string) => void
  }
): Promise<T> {
  const maxRetries = options?.maxRetries ?? AI_RETRY.MAX_RETRIES
  const noRetryCodes = new Set(options?.noRetryErrorCodes ?? NO_RETRY_BUSINESS_CODES)
  let networkAttempt = 0
  let rateLimitAttempt = 0
  let serverErrorAttempt = 0

  const _retry = async (): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      const apiErr = err as ApiRequestError

      // 不重试的业务错误
      if (apiErr.apiErrorCode && noRetryCodes.has(apiErr.apiErrorCode)) {
        throw apiErr
      }

      // 429 Rate Limit
      if (apiErr.statusCode === 429 && rateLimitAttempt < AI_RETRY.RATE_LIMIT_MAX_RETRIES) {
        rateLimitAttempt++
        const delay = apiErr.retryAfter ?? calculateBackoff(AI_RETRY.RATE_LIMIT_BASE_DELAY, rateLimitAttempt - 1)
        log.warn(`Rate limited (429), retry ${rateLimitAttempt}/${AI_RETRY.RATE_LIMIT_MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s`)
        options?.onRetry?.(rateLimitAttempt, delay, '429')
        await new Promise(resolve => setTimeout(resolve, delay))
        return _retry()
      }

      // 5xx 服务端错误
      if (apiErr.statusCode && AI_RETRY.RETRYABLE_STATUS_CODES.includes(apiErr.statusCode) &&
          serverErrorAttempt < AI_RETRY.SERVER_ERROR_MAX_RETRIES) {
        serverErrorAttempt++
        const delay = calculateBackoff(AI_RETRY.SERVER_ERROR_BASE_DELAY, serverErrorAttempt - 1)
        log.warn(`Server error (${apiErr.statusCode}), retry ${serverErrorAttempt}/${AI_RETRY.SERVER_ERROR_MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s`)
        options?.onRetry?.(serverErrorAttempt, delay, String(apiErr.statusCode))
        await new Promise(resolve => setTimeout(resolve, delay))
        return _retry()
      }

      // 网络错误
      if (isRetryableError(apiErr.message) && networkAttempt < maxRetries) {
        networkAttempt++
        const delay = calculateBackoff(AI_RETRY.BASE_DELAY, networkAttempt - 1)
        log.warn(`Network error (${apiErr.message.slice(0, 80)}), retry ${networkAttempt}/${maxRetries} in ${(delay / 1000).toFixed(1)}s`)
        options?.onRetry?.(networkAttempt, delay, 'network')
        await new Promise(resolve => setTimeout(resolve, delay))
        return _retry()
      }

      throw apiErr
    }
  }

  return _retry()
}

/**
 * 将 Node.js 网络错误消息翻译为用户可读的界面语言
 * 错误码是 Node.js 定义的稳定常量，不是关键词匹配
 */
const NET_ERROR_CODES = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'] as const

function translateNetworkError(errMessage: string): string {
  if (errMessage.includes('socket hang up')) {
    return t('error.net_socket_hang_up')
  }
  // 从 err.message（如 "getaddrinfo ENOTFOUND api.deepseek.com"）中提取错误码和主机名
  for (const code of NET_ERROR_CODES) {
    if (errMessage.includes(code)) {
      // 提取主机名：错误消息中错误码后面的部分，取第一段非空字符串
      const afterCode = errMessage.split(code)[1]?.trim() || ''
      const host = afterCode.split(/\s/)[0] || ''
      const key = `error.net_${code.toLowerCase()}` as Parameters<typeof t>[0]
      return t(key, { host })
    }
  }
  return errMessage
}

/**
 * AI API 业务错误到友好文案的映射
 * 所有键都是厂商协议里稳定的字符串常量（code 或 type），不做关键词匹配
 *
 * 覆盖的典型场景与厂商：
 *  - 余额/配额用尽：OpenAI/通义 `insufficient_quota`、`insufficient_user_quota`、阿里云 `ArrearsError`
 *  - API Key 无效：OpenAI `invalid_api_key`、Anthropic `authentication_error`、通用 `unauthorized`
 *  - 权限/地区受限：`permission_denied`、`permission_error`、`model_not_accessible`、`access_denied`、`region_not_supported`
 *  - 模型不存在：OpenAI `model_not_found`、Anthropic `not_found_error`
 *  - 内容安全：`content_filter`、`content_filtered`、阿里云 `data_inspection_failed`、`risk_control`
 *  - 服务端过载：Anthropic `overloaded_error`
 *  - 限流：`rate_limit_exceeded`、Anthropic `rate_limit_error`、`requests_per_minute_exceeded`、`tokens_per_minute_exceeded`
 */
const API_ERROR_CODE_MAP: Record<string, 'error.api_insufficient_quota' | 'error.api_invalid_key' | 'error.api_permission_denied' | 'error.api_model_not_found' | 'error.api_content_filtered' | 'error.api_overloaded' | 'error.api_rate_limited'> = {
  insufficient_quota: 'error.api_insufficient_quota',
  insufficient_user_quota: 'error.api_insufficient_quota',
  arrearserror: 'error.api_insufficient_quota',
  invalid_api_key: 'error.api_invalid_key',
  authentication_error: 'error.api_invalid_key',
  unauthorized: 'error.api_invalid_key',
  permission_denied: 'error.api_permission_denied',
  permission_error: 'error.api_permission_denied',
  model_not_accessible: 'error.api_permission_denied',
  access_denied: 'error.api_permission_denied',
  region_not_supported: 'error.api_permission_denied',
  model_not_found: 'error.api_model_not_found',
  not_found_error: 'error.api_model_not_found',
  content_filter: 'error.api_content_filtered',
  content_filtered: 'error.api_content_filtered',
  data_inspection_failed: 'error.api_content_filtered',
  risk_control: 'error.api_content_filtered',
  overloaded_error: 'error.api_overloaded',
  rate_limit_exceeded: 'error.api_rate_limited',
  rate_limit_error: 'error.api_rate_limited',
  requests_per_minute_exceeded: 'error.api_rate_limited',
  tokens_per_minute_exceeded: 'error.api_rate_limited'
}

/**
 * 明确属于"调用方错误、重试无意义"的业务码
 * withApiRetry 在这些码上直接放弃，避免把欠费/鉴权错误当成限流反复重试
 */
const NO_RETRY_BUSINESS_CODES: readonly string[] = [
  'context_length_exceeded',
  ...Object.keys(API_ERROR_CODE_MAP).filter(k =>
    API_ERROR_CODE_MAP[k] !== 'error.api_overloaded' &&
    API_ERROR_CODE_MAP[k] !== 'error.api_rate_limited'
  )
]

/**
 * 把原始 API 错误翻译为用户可读的文案
 * - 先按厂商 code/type 精确匹配（最准确）
 * - code 缺失或未知时按 HTTP 状态码粗分类（401/402/403/404/429/503/529）
 * - 两者都未命中时返回 null，由调用方回退到 translateNetworkError 或原始消息
 */
function translateApiBusinessError(
  statusCode: number | undefined,
  apiErrorCode: string | undefined,
  model?: string
): string | null {
  const code = apiErrorCode?.toLowerCase()
  if (code && API_ERROR_CODE_MAP[code]) {
    const key = API_ERROR_CODE_MAP[code]
    return t(key, { model: model || '' })
  }
  if (statusCode !== undefined) {
    switch (statusCode) {
      case 401: return t('error.api_invalid_key')
      case 402: return t('error.api_insufficient_quota')
      case 403: return t('error.api_permission_denied')
      case 404: return t('error.api_model_not_found', { model: model || '' })
      case 429: return t('error.api_rate_limited')
      case 503:
      case 529: return t('error.api_overloaded')
    }
  }
  return null
}

/**
 * 从抛出的 Error 中提取 ApiRequestError 附加信息（statusCode / apiErrorCode）并翻译
 * 未命中业务错误时返回 null，由调用方继续走 translateNetworkError 兜底
 */
function tryFriendlyApiError(err: unknown, model?: string): string | null {
  if (!(err instanceof Error)) return null
  const apiErr = err as ApiRequestError
  return translateApiBusinessError(apiErr.statusCode, apiErr.apiErrorCode, model)
}

/**
 * 解析 API 返回的错误响应体，提取结构化的错误信息
 * 避免将原始 JSON（如 {"error":{"message":"...","type":"...","param":null,...}}）直接展示给用户
 */
function parseApiError(rawBody: string): { message: string; code?: string } {
  try {
    const parsed = JSON.parse(rawBody)
    if (parsed?.error) {
      // OpenAI 格式: {"error": {"message":"...", "type":"...", "code":"..."}}
      if (typeof parsed.error === 'object') {
        return {
          message: parsed.error.message || rawBody,
          code: parsed.error.code || parsed.error.type
        }
      }
      // vLLM/SGLang 格式: {"error":"...", "error_type":"..."}
      if (typeof parsed.error === 'string') {
        return {
          message: parsed.error,
          code: parsed.error_type || undefined
        }
      }
    }
  } catch {
    // 非 JSON，原样返回（截断过长内容）
  }
  return { message: rawBody.length > 300 ? rawBody.slice(0, 300) + '...' : rawBody }
}

// 多模态消息内容部分（OpenAI Vision API 格式）
export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]  // 图片 base64 data URL 列表（仅 user 消息），发送时会转为多模态格式
  tool_call_id?: string  // 用于 tool 角色的消息
  tool_calls?: ToolCall[]  // 用于 assistant 角色的工具调用
  /**
   * think 模型的思考内容（DeepSeek-R1 / DeepSeek V3.2+ 等）。
   *
   * 重要：当 assistant 消息包含 `tool_calls` 时，此字段必须在后续所有请求中
   * 回传给 API（即使值为空字符串），否则 DeepSeek V3.2+ 思考模式会返回 400。
   * `formatMessageForApi` 会在字段缺失时自动补空串，新建/保存消息时请用
   * `!== undefined` 判断以保留空字符串值。
   */
  reasoning_content?: string
  /** @internal Anthropic prompt cache: 标记此消息为缓存断点（跨任务复用的消息边界） */
  _cacheBreakpoint?: boolean
}

interface ToolParameterSchema {
  type: string
  description?: string
  enum?: string[]
  items?: ToolParameterSchema
  properties?: Record<string, ToolParameterSchema>
  required?: string[]
}

// Tool Calling 相关类型
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, ToolParameterSchema>
      required?: string[]
    }
  }
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string  // JSON 字符串
  }
}

export interface TokenUsageInfo {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  // 缓存统计（各家字段不同，统一归一化）
  cache_hit_tokens?: number   // 缓存命中的输入 token 数
  cache_miss_tokens?: number  // 缓存未命中的输入 token 数
}

export interface ChatWithToolsResult {
  content?: string
  tool_calls?: ToolCall[]
  finish_reason?: 'stop' | 'tool_calls' | 'length'
  reasoning_content?: string  // think 模型的思考内容
  usage?: TokenUsageInfo
}

export type { AiModelType } from './config.service'

export interface AiProfile {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
  proxy?: string
  contextLength?: number  // 模型上下文长度（tokens），默认 128000
  maxOutputTokens?: number  // 单次回复最大输出 token 数，默认 8192
  temperature?: number  // 采样温度，留空则自动选择（默认 0.7，部分模型如 Kimi K2.5 强制为 1）
  modelType?: import('./config.service').AiModelType  // 模型类型，默认 general
  visionProfileId?: string  // 关联的视觉模型 Profile ID（仅 general 类型有效）
  apiFormat?: import('./config.service').ApiFormat  // API 协议格式，默认 auto
}

/**
 * 检测 API 错误是否因为不支持多模态/视觉输入
 * - 部分网关会明确写 image_url / content 类型
 * - 火山方舟等返回「Model do not support image input」不含 image_url 字样，也需识别以便降级重试
 */
function isVisionNotSupportedError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase()
  if (lower.includes('image_url') && (
    lower.includes('unknown variant') ||
    lower.includes('not supported') ||
    lower.includes('invalid type') ||
    lower.includes('invalid_type') ||
    lower.includes('expected `text`') ||
    lower.includes("expected 'text'")
  )) {
    return true
  }
  if (
    (lower.includes('not support') && lower.includes('image')) ||
    (lower.includes('does not support') && lower.includes('image')) ||
    (lower.includes('unsupported') && lower.includes('image')) ||
    (lower.includes('image input') && (
      lower.includes('not support') ||
      lower.includes('unsupported') ||
      lower.includes('do not support')
    ))
  ) {
    return true
  }
  return false
}

/**
 * 检测请求含图片时 API 返回的参数错误（宽松匹配）
 * 部分 API（如智谱 GLM-5）对不支持的 content 类型只返回泛化错误，
 * 不会在错误消息中提及 image_url，此函数捕获这类情况。
 * 仅在 hasImages=true 时调用，避免误伤。
 */
function isGenericParamErrorWithImages(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase()
  return (
    lower.includes('参数有误') ||
    lower.includes('invalid parameter') ||
    lower.includes('invalid_request_error') ||
    lower.includes('unrecognized request argument') ||
    lower.includes('invalid content type') ||
    lower.includes('invalid message format')
  )
}

/**
 * 解析模型的合适 temperature 值
 * 部分模型有固定 temperature 要求（如 Kimi K2.5 只允许 temperature=1），
 * 此函数根据模型名称返回合适的值，未命中时返回 defaultTemp。
 */
function resolveTemperature(profile: { model: string; temperature?: number }, defaultTemp = 0.7): number {
  if (typeof profile.temperature === 'number' && !isNaN(profile.temperature)) {
    return Math.max(0, Math.min(2, profile.temperature))
  }
  const lower = profile.model.toLowerCase()
  if (lower.includes('k2.5') || lower.includes('k-2.5')) return 1
  return defaultTemp
}

/**
 * 检测消息列表中是否包含会发往 API 的多模态图片（与 formatMessageForApi 一致，仅 user 角色）
 */
function messagesContainImages(messages: AiMessage[]): boolean {
  return messages.some(m => m.role === 'user' && m.images && m.images.length > 0)
}

/**
 * 将 AiMessage 转换为 API 请求格式
 * 如果消息包含图片，content 会转为多模态数组格式（OpenAI Vision API）
 * @param stripImages 为 true 时忽略图片（用于 API 不支持视觉时的降级）
 */
function formatMessageForApi(msg: AiMessage, stripImages = false): Record<string, unknown> {
  if (msg.role === 'tool') {
    return {
      role: 'tool' as const,
      content: msg.content || '[no output]',
      tool_call_id: msg.tool_call_id
    }
  }
  if (msg.role === 'assistant' && msg.tool_calls) {
    const assistantMsg: Record<string, unknown> = {
      role: 'assistant' as const,
      content: msg.content || null,
      tool_calls: msg.tool_calls,
      // DeepSeek V3.2+ 思考模式：带 tool_calls 的 assistant 消息必须回传 reasoning_content
      // 字段不存在（历史消息 / 非思考模型）时补空串，兼容其余 OpenAI 兼容 API（忽略未知字段）
      reasoning_content: msg.reasoning_content ?? ''
    }
    return assistantMsg
  }
  // user / system 消息：如果有图片且未要求剥离，转为多模态格式
  if (!stripImages && msg.images && msg.images.length > 0 && msg.role === 'user') {
    const parts: AiContentPart[] = []
    // 文本部分
    if (msg.content) {
      parts.push({ type: 'text', text: msg.content })
    }
    // 图片部分（指定 high detail 确保文字清晰可读）
    for (const imageUrl of msg.images) {
      parts.push({ type: 'image_url', image_url: { url: imageUrl, detail: 'high' } })
    }
    return {
      role: msg.role,
      content: parts
    }
  }
  // vLLM 等推理引擎拒绝空 content，纯 assistant 文本消息也需保护
  const content = msg.content || (msg.role === 'assistant' ? '[no response]' : ' ')
  const result: Record<string, unknown> = { role: msg.role, content }
  // DeepSeek V3.2+ 思考模式：纯文本 assistant 消息如带 reasoning_content 也需回传（任一 assistant 消息缺失都会被拒）
  // 其余 OpenAI 兼容 API 忽略未知字段，不会受影响；仅在字段存在时才附加，避免误伤非思考模型
  if (msg.role === 'assistant' && msg.reasoning_content !== undefined) {
    result.reasoning_content = msg.reasoning_content
  }
  if (msg._cacheBreakpoint) result._cacheBreakpoint = true
  return result
}

/**
 * 从 API 返回的 usage 对象中提取缓存统计信息
 * 各家格式不同，统一归一化为 cache_hit_tokens / cache_miss_tokens
 * 
 * 部分代理（如火山引擎）可能同时返回多种格式，优先取有实际数据的
 */
function extractCacheStats(rawUsage: Record<string, unknown>): { cache_hit_tokens?: number; cache_miss_tokens?: number } {
  type CacheResult = { cache_hit_tokens: number; cache_miss_tokens: number }
  const candidates: CacheResult[] = []

  // DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens
  const dsHit = rawUsage.prompt_cache_hit_tokens as number | undefined
  const dsMiss = rawUsage.prompt_cache_miss_tokens as number | undefined
  if (dsHit !== undefined || dsMiss !== undefined) {
    candidates.push({ cache_hit_tokens: dsHit ?? 0, cache_miss_tokens: dsMiss ?? 0 })
  }

  // Anthropic: cache_read_input_tokens / cache_creation_input_tokens
  const anthropicRead = rawUsage.cache_read_input_tokens as number | undefined
  const anthropicCreate = rawUsage.cache_creation_input_tokens as number | undefined
  if (anthropicRead !== undefined || anthropicCreate !== undefined) {
    candidates.push({ cache_hit_tokens: anthropicRead ?? 0, cache_miss_tokens: anthropicCreate ?? 0 })
  }

  // OpenAI: prompt_tokens_details.cached_tokens
  const details = rawUsage.prompt_tokens_details as Record<string, unknown> | undefined
  if (details?.cached_tokens !== undefined) {
    const cached = details.cached_tokens as number
    const total = (rawUsage.prompt_tokens as number) || 0
    candidates.push({ cache_hit_tokens: cached, cache_miss_tokens: Math.max(0, total - cached) })
  }

  if (candidates.length === 0) return {}
  // 多个候选时优先取有实际数据（cache_hit > 0 或 cache_miss > 0）的
  return candidates.find(c => c.cache_hit_tokens > 0 || c.cache_miss_tokens > 0) || candidates[0]
}

// === Anthropic Native API Adapter ===

function isAnthropicApi(profile: { apiUrl: string; apiFormat?: string }): boolean {
  const format = profile.apiFormat || 'auto'
  if (format === 'openai') return false
  if (format === 'anthropic') return true
  // auto: 根据 URL 自动检测
  try {
    if (profile.apiUrl.includes('/chat/completions')) return false
    const url = new URL(profile.apiUrl)
    if (url.hostname === 'api.anthropic.com') return true
    if (url.pathname.startsWith('/anthropic')) return true
    return false
  } catch {
    log.warn(`Invalid API URL for format detection: ${profile.apiUrl}`)
    return false
  }
}

function getRequestHeaders(profile: AiProfile): Record<string, string> {
  if (isAnthropicApi(profile)) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': profile.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    }
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${profile.apiKey}`
  }
}

function convertToAnthropicBody(body: Record<string, unknown>): Record<string, unknown> {
  const rawMessages = body.messages as Array<Record<string, unknown>>
  let system = ''
  const messages: Array<Record<string, unknown>> = []

  for (const msg of rawMessages) {
    const role = msg.role as string

    if (role === 'system') {
      if (system) system += '\n'
      system += (msg.content as string) || ''
      continue
    }

    if (role === 'user') {
      const images = msg.images as string[] | undefined
      if (images && images.length > 0) {
        const parts: Array<Record<string, unknown>> = []
        if (msg.content) parts.push({ type: 'text', text: msg.content })
        for (const imgUrl of images) {
          const match = imgUrl.match(/^data:(image\/[^;]+);base64,(.+)$/)
          if (match) {
            parts.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
          }
        }
        messages.push({ role: 'user', content: parts })
        continue
      }
      if (Array.isArray(msg.content)) {
        const parts: Array<Record<string, unknown>> = []
        for (const part of msg.content as Array<Record<string, unknown>>) {
          if (part.type === 'text') {
            parts.push({ type: 'text', text: part.text })
          } else if (part.type === 'image_url') {
            const url = (part.image_url as Record<string, unknown>)?.url as string
            const match = url?.match(/^data:(image\/[^;]+);base64,(.+)$/)
            if (match) {
              parts.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
            } else if (url) {
              parts.push({ type: 'image', source: { type: 'url', url } })
            }
          }
        }
        messages.push({ role: 'user', content: parts })
        continue
      }
      messages.push({ role: 'user', content: msg.content })
      continue
    }

    if (role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = []
      if (msg.content) blocks.push({ type: 'text', text: msg.content })
      const tcs = msg.tool_calls as ToolCall[] | undefined
      if (tcs) {
        for (const tc of tcs) {
          let input = {}
          try { input = JSON.parse(tc.function.arguments) } catch { /* noop */ }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
        }
      }
      // 缓存断点 3/4：跨任务消息复用边界（前序任务的最后一条 assistant 消息）
      if (msg._cacheBreakpoint) {
        if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
        blocks[blocks.length - 1].cache_control = { type: 'ephemeral' }
        messages.push({ role: 'assistant', content: blocks })
      } else if (blocks.length === 1 && blocks[0].type === 'text') {
        messages.push({ role: 'assistant', content: blocks[0].text })
      } else if (blocks.length > 0) {
        messages.push({ role: 'assistant', content: blocks })
      } else {
        messages.push({ role: 'assistant', content: [{ type: 'text', text: '' }] })
      }
      continue
    }

    if (role === 'tool') {
      const result = {
        type: 'tool_result' as const,
        tool_use_id: msg.tool_call_id as string,
        content: (msg.content as string) || ''
      }
      const last = messages[messages.length - 1]
      if (last?.role === 'user' && Array.isArray(last.content) &&
          (last.content as Array<Record<string, unknown>>).every(c => c.type === 'tool_result')) {
        (last.content as Array<Record<string, unknown>>).push(result)
      } else {
        messages.push({ role: 'user', content: [result] })
      }
      continue
    }
  }

  const result: Record<string, unknown> = {
    model: body.model,
    max_tokens: body.max_tokens || 4096,
    messages
  }
  if (system) {
    // Anthropic prompt caching: 将系统提示拆分为稳定部分（缓存）和动态部分
    // 缓存断点 1/4：系统提示的稳定前缀
    const CACHE_BREAK = '<!-- CACHE_BREAK -->'
    const breakIdx = system.indexOf(CACHE_BREAK)
    if (breakIdx !== -1) {
      const stablePart = system.substring(0, breakIdx).trim()
      const dynamicPart = system.substring(breakIdx + CACHE_BREAK.length).trim()
      const blocks: Array<Record<string, unknown>> = []
      if (stablePart) {
        blocks.push({ type: 'text', text: stablePart, cache_control: { type: 'ephemeral' } })
      }
      if (dynamicPart) {
        blocks.push({ type: 'text', text: dynamicPart })
      }
      result.system = blocks
    } else {
      // 没有分隔符时，整个系统提示标记为缓存
      result.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    }
  }
  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.stream) result.stream = true

  const tools = body.tools as ToolDefinition[] | undefined
  if (tools && tools.length > 0) {
    const anthropicTools = tools.map(td => ({
      name: td.function.name,
      description: td.function.description,
      input_schema: td.function.parameters
    }))
    // 缓存断点 2/4：工具定义列表（会话内稳定不变）
    if (anthropicTools.length > 0) {
      (anthropicTools[anthropicTools.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' }
    }
    result.tools = anthropicTools
    if (body.tool_choice === 'auto') {
      result.tool_choice = { type: 'auto' }
    } else if (body.tool_choice === 'none') {
      result.tool_choice = { type: 'none' }
    } else if (body.tool_choice === 'required') {
      result.tool_choice = { type: 'any' }
    }
  }

  return result
}

function convertFromAnthropicResponse(resp: Record<string, unknown>): Record<string, unknown> {
  if (resp.type === 'error') {
    const err = resp.error as Record<string, unknown> | undefined
    return {
      error: {
        message: err?.message || 'Unknown Anthropic API error',
        type: err?.type,
        code: err?.type
      }
    }
  }

  const contentBlocks = resp.content as Array<Record<string, unknown>> | undefined
  let text = ''
  const toolCalls: ToolCall[] = []

  if (contentBlocks) {
    for (const block of contentBlocks) {
      if (block.type === 'text') text += (block.text as string) || ''
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: (block.id as string) || '',
          type: 'function',
          function: {
            name: (block.name as string) || '',
            arguments: JSON.stringify(block.input || {})
          }
        })
      }
    }
  }

  const message: Record<string, unknown> = { role: 'assistant', content: text || null }
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  const stopReason = resp.stop_reason as string
  const finishReason = stopReason === 'tool_use' ? 'tool_calls'
    : stopReason === 'max_tokens' ? 'length' : 'stop'

  const rawUsage = resp.usage as Record<string, unknown> | undefined
  const usage = rawUsage ? {
    prompt_tokens: (rawUsage.input_tokens as number) ?? 0,
    completion_tokens: (rawUsage.output_tokens as number) ?? 0,
    total_tokens: ((rawUsage.input_tokens as number) ?? 0) + ((rawUsage.output_tokens as number) ?? 0),
    ...extractCacheStats(rawUsage)
  } : undefined

  return { choices: [{ message, finish_reason: finishReason }], usage }
}

interface AnthropicStreamDelta {
  content?: string
  reasoning_content?: string
  tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
  finish_reason?: string
  done?: boolean
  usage?: { input_tokens?: number; output_tokens?: number }
  rawUsage?: Record<string, unknown>
}

function parseAnthropicStreamEvent(data: string): AnthropicStreamDelta | null {
  try {
    const json = JSON.parse(data) as Record<string, unknown>
    switch (json.type) {
      case 'content_block_start': {
        const cb = json.content_block as Record<string, unknown>
        if (cb?.type === 'tool_use') {
          return {
            tool_calls: [{
              index: json.index as number,
              id: cb.id as string,
              function: { name: cb.name as string }
            }]
          }
        }
        return null
      }
      case 'content_block_delta': {
        const d = json.delta as Record<string, unknown>
        if (d?.type === 'text_delta') return { content: d.text as string }
        if (d?.type === 'input_json_delta') {
          return {
            tool_calls: [{
              index: json.index as number,
              function: { arguments: d.partial_json as string }
            }]
          }
        }
        if (d?.type === 'thinking_delta') return { reasoning_content: d.thinking as string }
        return null
      }
      case 'message_start': {
        const msg = json.message as Record<string, unknown>
        const u = msg?.usage as Record<string, unknown> | undefined
        if (u?.input_tokens) return { usage: { input_tokens: u.input_tokens as number }, rawUsage: u }
        return null
      }
      case 'message_delta': {
        const d = json.delta as Record<string, unknown>
        const sr = d?.stop_reason as string
        const u = json.usage as Record<string, number> | undefined
        const result: AnthropicStreamDelta = {}
        if (sr) {
          result.finish_reason = sr === 'tool_use' ? 'tool_calls' : sr === 'max_tokens' ? 'length' : 'stop'
        }
        if (u?.output_tokens) {
          result.usage = { output_tokens: u.output_tokens }
        }
        return (result.finish_reason || result.usage) ? result : null
      }
      case 'message_stop':
        return { done: true }
      default:
        return null
    }
  } catch {
    return null
  }
}

export class AiService {
  private configService: ConfigService
  // 使用 Map 存储多个请求的 AbortController，支持多个终端同时请求
  private abortControllers: Map<string, AbortController> = new Map()
  // 插件 provider（由 PluginRegistry 初始化后注入）
  private pluginProviders: Array<import('./plugin/types').ProviderRegistration> = []
  // 专用 HTTP agent，支持子 Agent 并发请求时连接池复用，避免 MaxListenersExceededWarning
  private readonly httpsAgent: https.Agent
  private readonly httpAgent: http.Agent

  constructor() {
    this.configService = new ConfigService()
    this.httpsAgent = new https.Agent({ keepAlive: true })
    this.httpsAgent.setMaxListeners(30)
    this.httpAgent = new http.Agent({ keepAlive: true })
    this.httpAgent.setMaxListeners(30)
  }

  /**
   * 注入插件 provider（由 PluginRegistry 初始化后调用）
   */
  setPluginProviders(providers: Array<import('./plugin/types').ProviderRegistration>): void {
    this.pluginProviders = providers
    if (providers.length > 0) {
      log.info(`Registered ${providers.length} plugin provider(s): ${providers.map(p => p.id).join(', ')}`)
    }
  }

  /**
   * 中止指定请求，如果不传 requestId 则中止所有请求
   */
  abort(requestId?: string): void {
    if (requestId) {
      const controller = this.abortControllers.get(requestId)
      if (controller) {
        controller.abort()
        this.abortControllers.delete(requestId)
      }
    } else {
      // 中止所有请求
      this.abortControllers.forEach(controller => controller.abort())
      this.abortControllers.clear()
    }
  }

  /**
   * 获取代理 Agent
   */
  private getProxyAgent(proxyUrl: string): HttpsProxyAgent<string> | SocksProxyAgent | undefined {
    if (!proxyUrl) return undefined

    if (proxyUrl.startsWith('socks')) {
      return new SocksProxyAgent(proxyUrl)
    } else {
      return new HttpsProxyAgent(proxyUrl)
    }
  }

  /**
   * 获取当前 AI Profile
   */
  private async getCurrentProfile(profileId?: string): Promise<AiProfile | null> {
    const profiles = this.configService.getAiProfiles()
    if (profiles.length === 0) return null

    if (profileId) {
      return profiles.find(p => p.id === profileId) || null
    }

    const activeId = this.configService.getActiveAiProfile()
    if (activeId) {
      return profiles.find(p => p.id === activeId) || profiles[0]
    }

    return profiles[0]
  }

  /**
   * 发送聊天请求（非流式）
   */
  async chat(messages: AiMessage[], profileId?: string): Promise<string> {
    const profile = await this.getCurrentProfile(profileId)
    if (!profile) {
      throw new Error(t('error.ai_no_config'))
    }

    const startTime = Date.now()
    log.info(`Chat request: model=${profile.model}, messages=${messages.length}`)

    const requestBody = {
      model: profile.model,
      messages,
      temperature: resolveTemperature(profile),
      max_tokens: 2048
    }

    try {
      const data = await this.makeRequest<{
        choices?: { message?: { content?: string } }[]
        error?: { message?: string; code?: string; type?: string }
      }>(profile, requestBody)

      if (data.error) {
        const code = data.error.code?.toLowerCase() || data.error.type?.toLowerCase() || ''
        if (code === 'context_length_exceeded') {
          throw new Error(t('error.context_length_exceeded'))
        }
        const friendly = translateApiBusinessError(undefined, code, profile.model)
        if (friendly) {
          throw new Error(friendly)
        }
        throw new Error(t('error.api_request_failed', { data: data.error.message || t('error.api_error_generic') }))
      }

      const result = data.choices?.[0]?.message?.content || ''
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      log.info(`Chat done: model=${profile.model}, duration=${elapsed}s, responseLen=${result.length}`)
      return result
    } catch (error) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const errMsg = error instanceof Error ? error.message : String(error)
      log.error(`Chat failed: model=${profile.model}, duration=${elapsed}s, error=${errMsg}`)
      if (error instanceof Error) {
        if (error.message === t('error.context_length_exceeded')) {
          throw error
        }
        // 先尝试匹配业务错误（欠费 / 鉴权 / 权限 / 模型不存在 / 内容安全等）
        const friendly = tryFriendlyApiError(error, profile.model)
        if (friendly) {
          throw new Error(friendly)
        }
        // 保留 makeRequest 已重试后的原始错误信息，翻译网络错误码
        throw new Error(t('error.ai_request_failed', { message: translateNetworkError(errMsg) }))
      }
      throw error
    }
  }

  /**
   * 发送单次 HTTP 请求（支持代理，带超时处理）
   * 抛出 ApiRequestError 携带 statusCode / retryAfter / apiErrorCode，供 withApiRetry 分类重试
   */
  private makeRequestOnce<T>(profile: AiProfile, body: object, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(profile.apiUrl)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: getRequestHeaders(profile),
        timeout: AI_TIMEOUT.CONNECT,
        agent: profile.proxy ? this.getProxyAgent(profile.proxy) : (isHttps ? this.httpsAgent : this.httpAgent)
      }

      let isCompleted = false
      const complete = (fn: () => void) => {
        if (!isCompleted) {
          isCompleted = true
          clearTimeout(totalTimeoutId)
          fn()
        }
      }

      // 总超时计时器
      const totalTimeoutId = setTimeout(() => {
        if (!isCompleted) {
          req.destroy()
          complete(() => reject(toApiRequestError(new Error(t('error.ai_total_timeout')))))
        }
      }, AI_TIMEOUT.TOTAL)

      const req = httpModule.request(options, (res) => {
        let data = ''
        
        // 设置 socket 空闲超时
        res.socket?.setTimeout(AI_TIMEOUT.SOCKET_IDLE)
        res.socket?.on('timeout', () => {
          req.destroy()
          complete(() => reject(toApiRequestError(new Error('ETIMEDOUT'))))
        })

        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            complete(() => {
              try {
                let parsed = JSON.parse(data)
                if (isAnthropicApi(profile)) {
                  parsed = convertFromAnthropicResponse(parsed)
                }
                resolve(parsed)
              } catch {
                reject(toApiRequestError(new Error(t('error.ai_parse_failed', { data }))))
              }
            })
          } else {
            const parsed = parseApiError(data)
            const headers = res.headers as Record<string, string | string[] | undefined>
            complete(() => reject(toApiRequestError(
              new Error(parsed.message),
              res.statusCode!,
              headers,
              parsed.code
            )))
          }
        })
      })

      // 连接超时处理
      req.on('timeout', () => {
        req.destroy()
        complete(() => reject(toApiRequestError(new Error('ETIMEDOUT'))))
      })

      req.on('error', (err) => {
        complete(() => reject(toApiRequestError(err)))
      })

      // 支持中止请求
      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy()
          complete(() => reject(toApiRequestError(new Error(t('error.request_aborted')))))
        })
      }

      const finalBody = isAnthropicApi(profile) ? convertToAnthropicBody(body as Record<string, unknown>) : body
      req.write(JSON.stringify(finalBody))
      req.end()
    })
  }

  /**
   * 发送 HTTP 请求（带自动重试：网络错误 / 429 / 5xx 均自动退避重试）
   */
  private makeRequest<T>(profile: AiProfile, body: object, signal?: AbortSignal): Promise<T> {
    return withApiRetry(() => this.makeRequestOnce<T>(profile, body, signal))
  }

  /**
   * 发送聊天请求（流式，支持代理）
   * 支持 think 模型（如 DeepSeek-R1）的 reasoning_content 字段
   * 支持网络错误 / 429 / 5xx 自动重试（指数退避 + jitter）
   * @param requestId 请求 ID，用于支持多个终端同时请求
   */
  async chatStream(
    messages: AiMessage[],
    onChunk: (chunk: string) => void,
    onDone: () => void,
    onError: (error: string) => void,
    profileId?: string,
    requestId?: string
  ): Promise<void> {
    const profile = await this.getCurrentProfile(profileId)
    if (!profile) {
      onError(t('error.ai_no_config'))
      return
    }

    const isAnthropic = isAnthropicApi(profile)
    const streamStartTime = Date.now()
    log.info(`ChatStream request: model=${profile.model}, messages=${messages.length}`)

    const originalOnDone = onDone
    const originalOnError = onError
    onDone = () => {
      const elapsed = ((Date.now() - streamStartTime) / 1000).toFixed(1)
      log.info(`ChatStream done: model=${profile.model}, duration=${elapsed}s`)
      originalOnDone()
    }
    onError = (error: string) => {
      const elapsed = ((Date.now() - streamStartTime) / 1000).toFixed(1)
      log.error(`ChatStream failed: model=${profile.model}, duration=${elapsed}s, error=${error}`)
      originalOnError(error)
    }

    const requestBody = {
      model: profile.model,
      messages,
      temperature: resolveTemperature(profile),
      max_tokens: 2048,
      stream: true
    }

    // 创建 AbortController，使用 requestId 或生成一个唯一 ID
    const reqId = requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const abortController = new AbortController()
    this.abortControllers.set(reqId, abortController)

    // 完成状态标记，防止重复回调
    let isCompleted = false
    // 总超时计时器
    let totalTimeoutId: NodeJS.Timeout
    // 空闲超时计时器（收到数据后重置）
    let idleTimeoutId: NodeJS.Timeout
    // 请求对象引用
    let req: http.ClientRequest | undefined
    // 重试计数器
    let networkRetryCount = 0
    let rateLimitRetryCount = 0
    let serverErrorRetryCount = 0

    // reasoning 输出状态
    let hasReasoningOutput = false
    let hasContentOutput = false

    const complete = (fn: () => void) => {
      if (!isCompleted) {
        isCompleted = true
        clearTimeout(totalTimeoutId)
        clearTimeout(idleTimeoutId)
        this.abortControllers.delete(reqId)
        fn()
      }
    }

    const resetForRetry = () => {
      clearTimeout(totalTimeoutId)
      clearTimeout(idleTimeoutId)
      req = undefined
      hasReasoningOutput = false
      hasContentOutput = false
    }

    const closeOpenReasoningBlock = () => {
      if (hasReasoningOutput && !hasContentOutput) {
        onChunk('\n\n</blockquote>\n</details>\n\n')
        hasReasoningOutput = false
      }
    }

    const resetIdleTimeout = () => {
      clearTimeout(idleTimeoutId)
      idleTimeoutId = setTimeout(() => {
        if (!isCompleted) {
          req?.destroy()
          if (!tryRetry('ETIMEDOUT')) {
            complete(() => onError(t('error.ai_idle_timeout')))
          }
        }
      }, AI_TIMEOUT.SOCKET_IDLE)
    }

    const tryRetry = (errorMsg: string, statusCode?: number, retryAfterMs?: number): boolean => {
      if (isCompleted) return true

      // 429 Rate Limit
      if (statusCode === 429 && rateLimitRetryCount < AI_RETRY.RATE_LIMIT_MAX_RETRIES) {
        rateLimitRetryCount++
        const delay = retryAfterMs ?? calculateBackoff(AI_RETRY.RATE_LIMIT_BASE_DELAY, rateLimitRetryCount - 1)
        log.warn(`ChatStream rate limited (429), retry ${rateLimitRetryCount}/${AI_RETRY.RATE_LIMIT_MAX_RETRIES} in ${(delay / 1000).toFixed(0)}s`)
        closeOpenReasoningBlock()
        onChunk(`⚠️ ${t('error.rate_limited', { seconds: (delay / 1000).toFixed(0), attempt: String(rateLimitRetryCount), max: String(AI_RETRY.RATE_LIMIT_MAX_RETRIES) })}\n`)
        resetForRetry()
        setTimeout(doRequest, delay)
        isCompleted = true
        return true
      }

      // 5xx 服务端错误
      if (statusCode && AI_RETRY.RETRYABLE_STATUS_CODES.includes(statusCode) && serverErrorRetryCount < AI_RETRY.SERVER_ERROR_MAX_RETRIES) {
        serverErrorRetryCount++
        const delay = calculateBackoff(AI_RETRY.SERVER_ERROR_BASE_DELAY, serverErrorRetryCount - 1)
        log.warn(`ChatStream server error (${statusCode}), retry ${serverErrorRetryCount}/${AI_RETRY.SERVER_ERROR_MAX_RETRIES} in ${(delay / 1000).toFixed(0)}s`)
        closeOpenReasoningBlock()
        onChunk(`⚠️ ${t('error.server_error_retry', { status: String(statusCode), seconds: (delay / 1000).toFixed(0), attempt: String(serverErrorRetryCount), max: String(AI_RETRY.SERVER_ERROR_MAX_RETRIES) })}\n`)
        resetForRetry()
        setTimeout(doRequest, delay)
        isCompleted = true
        return true
      }

      // 网络错误
      if (networkRetryCount < AI_RETRY.MAX_RETRIES && isRetryableError(errorMsg)) {
        networkRetryCount++
        const delay = calculateBackoff(AI_RETRY.BASE_DELAY, networkRetryCount - 1)
        log.warn(`ChatStream network error, retry ${networkRetryCount}/${AI_RETRY.MAX_RETRIES} in ${(delay / 1000).toFixed(0)}s`)
        closeOpenReasoningBlock()
        onChunk(`⚠️ ${t('error.network_retry', { attempt: String(networkRetryCount), max: String(AI_RETRY.MAX_RETRIES) })}\n`)
        resetForRetry()
        setTimeout(doRequest, delay)
        isCompleted = true
        return true
      }

      return false
    }

    const doRequest = () => {
    isCompleted = false

    // 重试等待期间用户可能已取消请求
    if (abortController.signal.aborted) {
      this.abortControllers.delete(reqId)
      onDone()
      return
    }

    try {
      const url = new URL(profile.apiUrl)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: getRequestHeaders(profile),
        timeout: AI_TIMEOUT.CONNECT,
        agent: profile.proxy ? this.getProxyAgent(profile.proxy) : (isHttps ? this.httpsAgent : this.httpAgent)
      }

      totalTimeoutId = setTimeout(() => {
        if (!isCompleted) {
          req?.destroy()
          complete(() => onError(t('error.ai_total_timeout')))
        }
      }, AI_TIMEOUT.TOTAL)

      req = httpModule.request(options, (res) => {
        // 开始接收响应，启动空闲超时
        resetIdleTimeout()

        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errorData = ''
          res.on('data', (chunk) => { 
            errorData += chunk
            resetIdleTimeout()
          })
          res.on('end', () => {
            const parsed = parseApiError(errorData)
            if (parsed.code === 'context_length_exceeded') {
              complete(() => onError(t('error.context_length_exceeded')))
              return
            }
            // 解析 Retry-After header
            let retryAfterMs: number | undefined
            const retryAfterHeader = res.headers['retry-after']
            if (retryAfterHeader) {
              const seconds = Number(retryAfterHeader)
              if (!isNaN(seconds) && seconds > 0) retryAfterMs = seconds * 1000
              else {
                const date = Date.parse(String(retryAfterHeader))
                if (!isNaN(date)) retryAfterMs = Math.max(1000, date - Date.now())
              }
            }
            if (!tryRetry(parsed.message, res.statusCode, retryAfterMs)) {
              const friendly = translateApiBusinessError(res.statusCode, parsed.code, profile.model)
              complete(() => onError(friendly || t('error.api_request_failed', { data: parsed.message })))
            }
          })
          return
        }

        let buffer = ''

        res.on('data', (chunk: Buffer) => {
          // 收到数据，重置空闲超时
          resetIdleTimeout()

          buffer += chunk.toString()
          const lines = buffer.split('\n')
          // 保留最后一个可能不完整的行
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmedLine = line.trim()
            if (!trimmedLine) continue

            if (trimmedLine.startsWith('data: ')) {
              const data = trimmedLine.slice(6).trim()
              if (!data) continue

              let delta: { content?: string; reasoning_content?: string } | undefined
              let isDone = false

              if (isAnthropic) {
                const event = parseAnthropicStreamEvent(data)
                if (!event) continue
                isDone = !!event.done
                delta = event
              } else {
                if (data === '[DONE]') {
                  isDone = true
                } else {
                  try {
                    const json = JSON.parse(data)
                    delta = json.choices?.[0]?.delta
                  } catch { continue }
                }
              }

              if (isDone) {
                if (hasReasoningOutput && !hasContentOutput) {
                  onChunk('\n\n</details>\n')
                }
                complete(() => onDone())
                return
              }

              if (delta?.reasoning_content) {
                if (!hasReasoningOutput) {
                  hasReasoningOutput = true
                  onChunk('<details open>\n<summary>🤔 <strong>思考过程</strong>（点击折叠）</summary>\n\n<blockquote>\n\n')
                }
                onChunk(delta.reasoning_content)
              }

              if (delta?.content) {
                if (hasReasoningOutput && !hasContentOutput) {
                  hasContentOutput = true
                  onChunk('\n\n</blockquote>\n</details>\n\n---\n\n### 💬 回复\n\n')
                }
                onChunk(delta.content)
              }
            }
          }
        })

        res.on('end', () => {
          complete(() => onDone())
        })

        res.on('error', (err) => {
          if (!tryRetry(err.message)) {
            const friendly = tryFriendlyApiError(err, profile.model)
            complete(() => onError(friendly || t('error.ai_response_error', { message: translateNetworkError(err.message) })))
          }
        })
      })

      // 连接超时处理
      req.on('timeout', () => {
        req?.destroy()
        if (!tryRetry('ETIMEDOUT')) {
          complete(() => onError(t('error.ai_connection_timeout')))
        }
      })

      req.on('error', (err) => {
        if (abortController.signal.aborted) {
          complete(() => onDone())
          return
        }
        if (!tryRetry(err.message)) {
          const friendly = tryFriendlyApiError(err, profile.model)
          complete(() => onError(friendly || t('error.request_error', { message: translateNetworkError(err.message) })))
        }
      })

      // 支持中止请求
      abortController.signal.addEventListener('abort', () => {
        req?.destroy()
        complete(() => onDone())
      })

      const chatStreamBody = isAnthropic ? convertToAnthropicBody(requestBody as Record<string, unknown>) : requestBody
      req.write(JSON.stringify(chatStreamBody))
      req.end()
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      if (!tryRetry(errorMsg)) {
        if (error instanceof Error) {
          const friendly = tryFriendlyApiError(error, profile.model)
          complete(() => onError(friendly || t('error.ai_request_failed', { message: translateNetworkError(error.message) })))
        } else {
          complete(() => onError(t('error.ai_request_failed_unknown')))
        }
      }
    }
    }  // end of doRequest

    // 开始执行请求
    doRequest()
  }

  /**
   * 发送带工具调用的聊天请求（非流式）
   * 用于 Agent 模式，支持 function calling
   */
  async chatWithTools(
    messages: AiMessage[],
    tools: ToolDefinition[],
    profileId?: string,
    signal?: AbortSignal
  ): Promise<ChatWithToolsResult> {
    const profile = await this.getCurrentProfile(profileId)
    if (!profile) {
      throw new Error(t('error.ai_no_config'))
    }

    // 插件 provider 前置检查
    for (const provider of this.pluginProviders) {
      if (provider.match(profile)) {
        log.info(`Delegating to plugin provider "${provider.id}" for model=${profile.model}`)
        const result = await provider.chatWithTools({ messages: messages as ProviderChatParams['messages'], tools, model: profile.model, apiUrl: profile.apiUrl, apiKey: profile.apiKey })
        return result as ChatWithToolsResult
      }
    }

    const startTime = Date.now()
    const reqId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    log.info(`ChatWithTools request: model=${profile.model}, messages=${messages.length}, tools=${tools.length}`)

    const aiDebug = getAiDebugService()
    const hasImages = messagesContainImages(messages)

    aiDebug.logRequestStart(reqId, {
      profileId: profile.id,
      model: profile.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        tool_call_id: m.tool_call_id,
        tool_calls: m.tool_calls,
        reasoning_content: m.reasoning_content,
        images: m.images && m.images.length > 0
          ? m.images.map((img, i) => {
              const sizeKB = (img.length * 0.75 / 1024).toFixed(0)
              const mimeMatch = img.match(/^data:(image\/[^;]+);/)
              const mime = mimeMatch ? mimeMatch[1] : 'unknown'
              return `[image_${i}: ${mime}, ~${sizeKB}KB]`
            })
          : undefined
      })),
      tools
    })

    const doRequest = async (stripImages: boolean): Promise<ChatWithToolsResult> => {
      const fmtMessages = messages.map(msg => formatMessageForApi(msg, stripImages))

      const body = {
        model: profile.model,
        messages: fmtMessages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        temperature: resolveTemperature(profile),
        max_tokens: profile.maxOutputTokens || 8192
      }

      aiDebug.logRequestBody(reqId, body as unknown as Record<string, unknown>)

      let data: {
        choices?: {
          message?: {
            content?: string | null
            tool_calls?: ToolCall[]
          }
          finish_reason?: string
        }[]
        error?: { message?: string; code?: string; type?: string }
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      }

      try {
        data = await this.makeRequest(profile, body, signal)
      } catch (err) {
        if (signal?.aborted) throw new Error('Aborted')
        if (!stripImages && hasImages && err instanceof Error &&
            (isVisionNotSupportedError(err.message) || isGenericParamErrorWithImages(err.message))) {
          log.warn(`Model ${profile.model} may not support images (error: ${err.message}), retrying without images`)
          return doRequest(true)
        }
        throw err
      }

      if (data.error) {
        const code = data.error.code?.toLowerCase() || data.error.type?.toLowerCase() || ''
        if (code === 'context_length_exceeded') {
          throw new Error(t('error.context_length_exceeded'))
        }
        const errorMsg = data.error.message || t('error.api_error_generic')
        if (!stripImages && hasImages &&
            (isVisionNotSupportedError(errorMsg) || isGenericParamErrorWithImages(errorMsg))) {
          log.warn(`Model ${profile.model} may not support images (error: ${errorMsg}), retrying without images`)
          return doRequest(true)
        }
        const friendly = translateApiBusinessError(undefined, code, profile.model)
        if (friendly) {
          throw new Error(friendly)
        }
        throw new Error(t('error.api_request_failed', { data: errorMsg }))
      }

      const choice = data.choices?.[0]
      if (!choice) {
        throw new Error(t('error.ai_empty_response'))
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const toolNames = choice.message?.tool_calls?.map(tc => tc.function.name).join(', ') || ''
      log.info(`ChatWithTools done: model=${profile.model}, duration=${elapsed}s, finish=${choice.finish_reason}, tools=[${toolNames}]`)

      const normalizedUsage = data.usage ? {
        prompt_tokens: data.usage.prompt_tokens ?? 0,
        completion_tokens: data.usage.completion_tokens ?? 0,
        total_tokens: data.usage.total_tokens ?? 0,
        ...extractCacheStats(data.usage)
      } : undefined

      aiDebug.logResponseDone(reqId, {
        response: choice.message?.content || undefined,
        finishReason: choice.finish_reason,
        usage: normalizedUsage,
        toolCalls: choice.message?.tool_calls?.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments
        }))
      })

      return {
        content: choice.message?.content || undefined,
        tool_calls: choice.message?.tool_calls,
        finish_reason: choice.finish_reason as ChatWithToolsResult['finish_reason'],
        usage: normalizedUsage
      }
    }

    try {
      return await doRequest(false)
    } catch (error) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      log.error(`ChatWithTools failed: model=${profile.model}, duration=${elapsed}s, error=${error instanceof Error ? error.message : error}`)
      aiDebug.logResponseError(reqId, error instanceof Error ? error.message : String(error))
      if (error instanceof Error) {
        if (error.message === t('error.context_length_exceeded')) {
          throw error
        }
        const friendly = tryFriendlyApiError(error, profile.model)
        if (friendly) {
          throw new Error(friendly)
        }
        throw new Error(t('error.ai_request_failed', { message: translateNetworkError(error.message) }))
      }
      throw error
    }
  }

  /**
   * 带工具的聊天（流式）
   * 用于 Agent 模式，支持 function calling 和流式输出
   * 支持 think 模型（如 DeepSeek-R1）的 reasoning_content 字段
   */
  async chatWithToolsStream(
    messages: AiMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: string) => void,
    onToolCall: (toolCalls: ToolCall[]) => void,
    onDone: (result: ChatWithToolsResult) => void,
    onError: (error: string) => void,
    profileId?: string,
    onToolCallProgress?: (toolCallId: string, toolName: string, partialArgs: string) => void,  // 工具调用参数流式片段（含 toolCallId 以便前端就地更新对应卡片）
    requestId?: string,  // 用于支持中止请求
    onRetry?: () => void,  // 重试前通知调用方重置流状态（避免 reasoning 块重复）
    onToolCallReady?: (toolCall: ToolCall) => void  // 流式中某个 tool_call 参数完整时回调
  ): Promise<void> {
    const profile = await this.getCurrentProfile(profileId)
    if (!profile) {
      onError(t('error.ai_no_config'))
      return
    }

    const isAnthropic = isAnthropicApi(profile)

    // 创建 AbortController，使用 requestId 或生成一个唯一 ID
    const reqId = requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const abortController = new AbortController()
    this.abortControllers.set(reqId, abortController)

    const startTime = Date.now()
    log.info(`Request started: model=${profile.model}, messages=${messages.length}, tools=${tools.length}`)

    // AI Debug: 记录请求开始
    const requestHasImages = messagesContainImages(messages)
    if (requestHasImages) {
      const imageMessages = messages.filter(m => m.images && m.images.length > 0)
      log.info(`Request contains images: ${imageMessages.length} message(s) with images`)
    }
    getAiDebugService().logRequestStart(reqId, {
      profileId: profile.id,
      model: profile.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        tool_call_id: m.tool_call_id,
        tool_calls: m.tool_calls,
        reasoning_content: m.reasoning_content,
        images: m.images && m.images.length > 0
          ? m.images.map((img, i) => {
              const sizeKB = (img.length * 0.75 / 1024).toFixed(0)
              const mimeMatch = img.match(/^data:(image\/[^;]+);/)
              const mime = mimeMatch ? mimeMatch[1] : 'unknown'
              return `[image_${i}: ${mime}, ~${sizeKB}KB]`
            })
          : undefined
      })),
      tools
    })

    // 完成状态标记，防止重复回调
    let isCompleted = false
    // 总超时计时器
    let totalTimeoutId: NodeJS.Timeout
    // 空闲超时计时器（收到数据后重置）
    let idleTimeoutId: NodeJS.Timeout
    // 请求对象引用
    let req: http.ClientRequest | undefined
    // 重试计数器
    let retryCount = 0
    // Rate limit 重试计数器（独立于网络错误重试）
    let rateLimitRetryCount = 0
    // 5xx 服务端错误重试计数器（独立于网络错误重试）
    let serverErrorRetryCount = 0

    // 收集的数据
    let content = ''
    let reasoningContent = ''  // 用于收集 think 模型的思考内容
    let toolCalls: ToolCall[] = []
    let finishReason: string | undefined
    let streamUsage: ChatWithToolsResult['usage'] | undefined
    // reasoning 输出状态（需跨重试可见，以便重试前关闭未闭合的 <details> 块）
    let hasReasoningOutput = false
    let hasContentOutput = false
    // 流式工具就绪追踪：已通过 onToolCallReady 回调的 tool_call 索引
    const readyToolCallIndices = new Set<number>()

    const complete = (fn: () => void) => {
      if (!isCompleted) {
        isCompleted = true
        clearTimeout(totalTimeoutId)
        clearTimeout(idleTimeoutId)
        this.abortControllers.delete(reqId)
        fn()
      }
    }

    // 重置状态以便重试（不重置 isCompleted，由 tryRetry/doRequest 管理）
    const resetForRetry = () => {
      clearTimeout(totalTimeoutId)
      clearTimeout(idleTimeoutId)
      onRetry?.()
      content = ''
      reasoningContent = ''
      toolCalls = []
      finishReason = undefined
      streamUsage = undefined
      req = undefined
      hasReasoningOutput = false
      hasContentOutput = false
      readyToolCallIndices.clear()
    }

    // 关闭未闭合的 reasoning <details> 块（重试前调用，避免嵌套）
    // 当提供了 onRetry 时跳过 onChunk，因为调用方会整体重置流内容
    const closeOpenReasoningBlock = () => {
      if (hasReasoningOutput && !hasContentOutput) {
        if (!onRetry) {
          onChunk('\n\n</blockquote>\n</details>\n\n')
        }
        hasReasoningOutput = false
      }
    }

    const resetIdleTimeout = () => {
      clearTimeout(idleTimeoutId)
      idleTimeoutId = setTimeout(() => {
        if (!isCompleted) {
          req?.destroy()
          if (!tryRetry('ETIMEDOUT', doRequest)) {
            complete(() => onError(t('error.ai_idle_timeout')))
          }
        }
      }, AI_TIMEOUT.SOCKET_IDLE)
    }

    // 视觉降级标记：API 不支持 image_url 时自动剥离图片重试
    let stripImages = false
    const hasImages = messagesContainImages(messages)

    const rebuildRequestBody = () => {
      const fmtMsgs = messages.map(msg => formatMessageForApi(msg, stripImages))
      const body: Record<string, unknown> = {
        model: profile.model,
        messages: fmtMsgs,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        temperature: resolveTemperature(profile),
        max_tokens: profile.maxOutputTokens || 8192,
        stream: true
      }
      if (!isAnthropic) {
        body.stream_options = { include_usage: true }
      }
      return body
    }

    let requestBody = rebuildRequestBody()
    // 记录 formatMessageForApi 处理后的实际请求体（仅 messages），便于排查字段合规问题（如 DeepSeek reasoning_content）
    getAiDebugService().logRequestBody(reqId, requestBody)

    // 视觉降级重试：剥离图片后重新请求（最多触发一次）
    const tryVisionFallback = (errorMsg: string): boolean => {
      if (!stripImages && hasImages &&
          (isVisionNotSupportedError(errorMsg) || isGenericParamErrorWithImages(errorMsg))) {
        log.warn(`Model ${profile.model} may not support images (error: ${errorMsg}), retrying without images`)
        stripImages = true
        requestBody = rebuildRequestBody()
        closeOpenReasoningBlock()
        resetForRetry()
        doRequest()
        return true
      }
      return false
    }

    // 尝试重试的辅助函数（网络错误：指数退避 + jitter）
    const tryRetry = (errorMsg: string, doRequest: () => void): boolean => {
      // 已有重试在等待或请求已完成，跳过（防止 res/req 同时 emit error 导致重复重试）
      if (isCompleted) return true
      if (retryCount < AI_RETRY.MAX_RETRIES && isRetryableError(errorMsg)) {
        retryCount++
        const delay = calculateBackoff(AI_RETRY.BASE_DELAY, retryCount - 1)
        closeOpenReasoningBlock()
        if (!onRetry) {
          onChunk(`⚠️ ${t('error.network_retry', { attempt: String(retryCount), max: String(AI_RETRY.MAX_RETRIES) })}\n`)
        }
        getAiDebugService().logResponseError(reqId, `${errorMsg} - 准备重试 ${retryCount}/${AI_RETRY.MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s`)
        resetForRetry()
        setTimeout(doRequest, delay)
        // 阻止旧请求的其他错误处理器调用 complete()
        isCompleted = true
        return true
      }
      return false
    }

    const doRequest = () => {
    // 每次（重）试开始时允许 complete() 回调
    isCompleted = false

    // 重试等待期间用户可能已取消请求
    if (abortController.signal.aborted) {
      this.abortControllers.delete(reqId)
      getAiDebugService().logResponseDone(reqId, { finishReason: 'aborted' })
      onDone({
        content: undefined,
        tool_calls: undefined,
        finish_reason: 'stop'
      })
      return
    }

    try {
      const url = new URL(profile.apiUrl)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: getRequestHeaders(profile),
        timeout: AI_TIMEOUT.CONNECT,
        agent: profile.proxy ? this.getProxyAgent(profile.proxy) : (isHttps ? this.httpsAgent : this.httpAgent)
      }

      totalTimeoutId = setTimeout(() => {
        if (!isCompleted) {
          req?.destroy()
          complete(() => onError(t('error.ai_total_timeout')))
        }
      }, AI_TIMEOUT.TOTAL)

      req = httpModule.request(options, (res) => {
        // 开始接收响应，启动空闲超时
        resetIdleTimeout()

        // 处理 HTTP 错误
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errorData = ''
          res.on('data', (chunk) => { 
            errorData += chunk
            resetIdleTimeout()
          })
          res.on('end', () => {
            const parsed = parseApiError(errorData)
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            log.error(`Request HTTP error: model=${profile.model}, status=${res.statusCode}, duration=${elapsed}s, error=${parsed.message.slice(0, 200)}`)
            if (res.statusCode === 429 && rateLimitRetryCount < AI_RETRY.RATE_LIMIT_MAX_RETRIES) {
              // Rate limit: 优先 Retry-After header，否则指数退避 + jitter
              rateLimitRetryCount++
              const retryAfterHeader = res.headers['retry-after']
              let retryAfterMs = calculateBackoff(AI_RETRY.RATE_LIMIT_BASE_DELAY, rateLimitRetryCount - 1)
              if (retryAfterHeader) {
                const seconds = Number(retryAfterHeader)
                if (!isNaN(seconds) && seconds > 0) {
                  retryAfterMs = seconds * 1000
                } else {
                  const date = Date.parse(retryAfterHeader)
                  if (!isNaN(date)) {
                    retryAfterMs = Math.max(1000, date - Date.now())
                  }
                }
              }
              const retryAfterSec = (retryAfterMs / 1000).toFixed(0)
              log.warn(`Rate limited (429), retrying in ${retryAfterSec}s (${rateLimitRetryCount}/${AI_RETRY.RATE_LIMIT_MAX_RETRIES})`)
              closeOpenReasoningBlock()
              if (!onRetry) {
                onChunk(`⚠️ ${t('error.rate_limited', { seconds: retryAfterSec, attempt: String(rateLimitRetryCount), max: String(AI_RETRY.RATE_LIMIT_MAX_RETRIES) })}\n`)
              }
              getAiDebugService().logResponseError(reqId, `429 Rate Limited - retry ${rateLimitRetryCount}/${AI_RETRY.RATE_LIMIT_MAX_RETRIES} in ${retryAfterSec}s`)
              resetForRetry()
              setTimeout(doRequest, retryAfterMs)
              isCompleted = true
            } else if (parsed.code === 'context_length_exceeded') {
              complete(() => onError(t('error.context_length_exceeded')))
            } else if (res.statusCode && AI_RETRY.RETRYABLE_STATUS_CODES.includes(res.statusCode) && serverErrorRetryCount < AI_RETRY.SERVER_ERROR_MAX_RETRIES) {
              serverErrorRetryCount++
              const delay = calculateBackoff(AI_RETRY.SERVER_ERROR_BASE_DELAY, serverErrorRetryCount - 1)
              const delaySec = (delay / 1000).toFixed(0)
              log.warn(`Server error (${res.statusCode}), retrying in ${delaySec}s (${serverErrorRetryCount}/${AI_RETRY.SERVER_ERROR_MAX_RETRIES})`)
              closeOpenReasoningBlock()
              if (!onRetry) {
                onChunk(`⚠️ ${t('error.server_error_retry', { status: String(res.statusCode), seconds: delaySec, attempt: String(serverErrorRetryCount), max: String(AI_RETRY.SERVER_ERROR_MAX_RETRIES) })}\n`)
              }
              getAiDebugService().logResponseError(reqId, `${res.statusCode} Server Error - retry ${serverErrorRetryCount}/${AI_RETRY.SERVER_ERROR_MAX_RETRIES} in ${delaySec}s`)
              resetForRetry()
              setTimeout(doRequest, delay)
              isCompleted = true
            } else if (tryVisionFallback(parsed.message)) {
              // 已降级重试
            } else {
              const friendly = translateApiBusinessError(res.statusCode, parsed.code, profile.model)
              complete(() => onError(friendly || t('error.api_request_failed', { data: parsed.message })))
            }
          })
          return
        }

        let buffer = ''

        res.on('data', (chunk: Buffer) => {
          // 收到数据，重置空闲超时
          resetIdleTimeout()

          // 检查是否已被 abort，立即停止处理
          if (abortController.signal.aborted || isCompleted) {
            return
          }

          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (abortController.signal.aborted || isCompleted) return
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim()
              if (!data) continue

              let delta: AnthropicStreamDelta | { content?: string; reasoning_content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } | undefined
              let reason: string | undefined
              let isDone = false

              if (isAnthropic) {
                const event = parseAnthropicStreamEvent(data)
                if (!event) continue
                isDone = !!event.done
                delta = event
                reason = event.finish_reason
                if (event.usage) {
                  if (!streamUsage) streamUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                  if (event.usage.input_tokens) streamUsage.prompt_tokens = event.usage.input_tokens
                  if (event.usage.output_tokens) streamUsage.completion_tokens = event.usage.output_tokens
                  streamUsage.total_tokens = streamUsage.prompt_tokens + streamUsage.completion_tokens
                  if (event.rawUsage) {
                    const cacheStats = extractCacheStats(event.rawUsage)
                    if (cacheStats.cache_hit_tokens !== undefined) streamUsage.cache_hit_tokens = cacheStats.cache_hit_tokens
                    if (cacheStats.cache_miss_tokens !== undefined) streamUsage.cache_miss_tokens = cacheStats.cache_miss_tokens
                  }
                }
              } else {
                if (data === '[DONE]') {
                  isDone = true
                } else {
                  try {
                    const json = JSON.parse(data)
                    delta = json.choices?.[0]?.delta
                    reason = json.choices?.[0]?.finish_reason
                    if (json.usage) {
                      const cacheStats = extractCacheStats(json.usage)
                      streamUsage = {
                        prompt_tokens: json.usage.prompt_tokens ?? 0,
                        completion_tokens: json.usage.completion_tokens ?? 0,
                        total_tokens: json.usage.total_tokens ?? 0,
                        ...cacheStats
                      }
                      const extraKeys = Object.keys(json.usage).filter(k => !['prompt_tokens', 'completion_tokens', 'total_tokens'].includes(k))
                      if (extraKeys.length > 0) {
                        const extraData = Object.fromEntries(extraKeys.map(k => [k, json.usage[k]]))
                        log.info(`Stream usage details: ${JSON.stringify(extraData)}`)
                      }
                    }
                  } catch { continue }
                }
              }

              if (reason) finishReason = reason

              if (isDone) {
                if (hasReasoningOutput && !hasContentOutput) {
                  onChunk('\n\n</blockquote>\n</details>')
                }
                // 有 tool_calls 时不用 reasoning 兜底 content，避免 HTML 进入对话历史
                // reasoning 已通过 streaming onChunk 展示，且保存在 reasoning_content 字段中
                const hasToolCalls = toolCalls.length > 0
                const finalContent = content || (!hasToolCalls && reasoningContent ? `<details>\n<summary>🤔 <strong>${t('ai.thinking_process')}</strong></summary>\n\n<blockquote>\n\n${reasoningContent}\n\n</blockquote>\n</details>` : undefined)
                complete(() => onDone({
                  content: finalContent,
                  tool_calls: hasToolCalls ? toolCalls : undefined,
                  finish_reason: finishReason as ChatWithToolsResult['finish_reason'],
                  // 用 hasReasoningOutput 而非字符串非空作为"是否思考模式"标志：
                  // DeepSeek V3.2+ 要求带 tool_calls 的 assistant 在后续请求中回传此字段，
                  // 因此即使思考内容为空字符串也保留，避免被 || 转为 undefined 后丢失
                  reasoning_content: hasReasoningOutput ? reasoningContent : undefined,
                  usage: streamUsage
                }))
                return
              }

              if (delta?.reasoning_content) {
                if (!hasReasoningOutput) {
                  hasReasoningOutput = true
                  onChunk(`<details open>\n<summary>🤔 <strong>${t('ai.thinking_process')}</strong></summary>\n\n<blockquote>\n\n`)
                }
                reasoningContent += delta.reasoning_content
                onChunk(delta.reasoning_content)
                getAiDebugService().logResponseChunk(reqId, `[THINKING] ${delta.reasoning_content}`)
              }

              if (delta?.content) {
                if (hasReasoningOutput && !hasContentOutput) {
                  hasContentOutput = true
                  onChunk('\n\n</blockquote>\n</details>\n\n')
                }
                content += delta.content
                onChunk(delta.content)
                getAiDebugService().logResponseChunk(reqId, delta.content)
              }

              if (delta?.tool_calls) {
                if (hasReasoningOutput && !hasContentOutput) {
                  hasContentOutput = true
                  onChunk('\n\n</blockquote>\n</details>\n\n')
                }
                for (const tc of delta.tool_calls) {
                  const index = tc.index ?? 0
                  if (!toolCalls[index]) {
                    toolCalls[index] = {
                      id: tc.id || '',
                      type: 'function',
                      function: {
                        name: tc.function?.name || '',
                        arguments: tc.function?.arguments || ''
                      }
                    }
                  } else {
                    if (tc.id) toolCalls[index].id = tc.id
                    if (tc.function?.name) toolCalls[index].function.name = tc.function.name
                    if (tc.function?.arguments) toolCalls[index].function.arguments += tc.function.arguments
                  }
                  if (onToolCallProgress && toolCalls[index]) {
                    onToolCallProgress(
                      toolCalls[index].id,
                      toolCalls[index].function.name,
                      toolCalls[index].function.arguments
                    )
                  }
                  // 检测 tool_call 参数是否已完整（可解析为 JSON）
                  if (onToolCallReady && toolCalls[index] && !readyToolCallIndices.has(index)) {
                    const tc = toolCalls[index]
                    if (tc.id && tc.function.name && tc.function.arguments) {
                      try {
                        JSON.parse(tc.function.arguments)
                        readyToolCallIndices.add(index)
                        onToolCallReady(tc)
                      } catch {
                        // 参数尚不完整，继续等待
                      }
                    }
                  }
                }
              }
            }
          }
        })

        res.on('end', () => {
          // 流结束但未收到 [DONE] 或 finish_reason：检测不完整的 tool calls
          // 某些 API 在 max_tokens 截断时可能不发送 finish_reason 就断流
          if (!finishReason && toolCalls.length > 0) {
            const hasIncomplete = toolCalls.some(tc => {
              if (!tc.function.arguments) return true
              try { JSON.parse(tc.function.arguments); return false }
              catch (e) { if (e instanceof SyntaxError) return true; throw e }
            })
            if (hasIncomplete) {
              finishReason = 'length'
              log.warn(`Stream ended without finish_reason but has incomplete tool_calls, treating as length truncation`)
            }
          }

          if (!isCompleted && hasReasoningOutput && !hasContentOutput) {
            onChunk('\n\n</blockquote>\n</details>')
          }
          const hasToolCalls = toolCalls.length > 0
          const finalContent = content || (!hasToolCalls && reasoningContent ? `<details>\n<summary>🤔 <strong>${t('ai.thinking_process')}</strong></summary>\n\n<blockquote>\n\n${reasoningContent}\n\n</blockquote>\n</details>` : undefined)

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          const toolNames = toolCalls.map(tc => tc.function.name).join(', ')
          let usageStr = streamUsage ? `, tokens=${streamUsage.prompt_tokens}+${streamUsage.completion_tokens}=${streamUsage.total_tokens}` : ''
          if (streamUsage?.cache_hit_tokens !== undefined) {
            const hitRate = streamUsage.prompt_tokens > 0 ? Math.round(streamUsage.cache_hit_tokens / streamUsage.prompt_tokens * 100) : 0
            usageStr += `, cache=${streamUsage.cache_hit_tokens}/${streamUsage.cache_miss_tokens ?? '?'}(${hitRate}%hit)`
          }
          log.info(`Request done: model=${profile.model}, duration=${elapsed}s, finish=${finishReason || 'end'}, tools=[${toolNames}], contentLen=${(finalContent || '').length}${usageStr}`)

          // AI Debug: 记录响应完成（包含工具调用）
          getAiDebugService().logResponseDone(reqId, {
            response: finalContent,
            reasoningContent: hasReasoningOutput ? reasoningContent : undefined,
            finishReason,
            usage: streamUsage,
            toolCalls: hasToolCalls ? toolCalls.map(tc => ({
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments
            })) : undefined
          })
          if (hasToolCalls) {
            onToolCall(toolCalls)
          }
          complete(() => onDone({
            content: finalContent,
            tool_calls: hasToolCalls ? toolCalls : undefined,
            finish_reason: finishReason as ChatWithToolsResult['finish_reason'],
            reasoning_content: hasReasoningOutput ? reasoningContent : undefined,
            usage: streamUsage
          }))
        })

        res.on('error', (err) => {
          if (abortController.signal.aborted) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            log.debug(`Request aborted: model=${profile.model}, duration=${elapsed}s`)
            getAiDebugService().logResponseDone(reqId, { finishReason: 'aborted' })
            complete(() => onDone({
              content: undefined,
              tool_calls: undefined,
              finish_reason: 'stop'
            }))
            return
          }
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          log.error(`Request failed: model=${profile.model}, duration=${elapsed}s, error=${err.message}`)
          if (!tryRetry(err.message, doRequest)) {
            getAiDebugService().logResponseError(reqId, err.message)
            const friendly = tryFriendlyApiError(err, profile.model)
            complete(() => onError(friendly || t('error.request_error', { message: translateNetworkError(err.message) })))
          }
        })
      })

      // 连接超时处理
      req.on('timeout', () => {
        req?.destroy()
        if (!tryRetry('ETIMEDOUT', doRequest)) {
          const errorMsg = t('error.ai_connection_timeout')
          getAiDebugService().logResponseError(reqId, errorMsg)
          complete(() => onError(errorMsg))
        }
      })

      req.on('error', (err) => {
        // 只有用户主动中止时才静默处理（socket hang up 也可能是网络断开，不能一律吞掉）
        if (abortController.signal.aborted) {
          getAiDebugService().logResponseDone(reqId, { finishReason: 'aborted' })
          complete(() => onDone({
            content: undefined,
            tool_calls: undefined,
            finish_reason: 'stop'
          }))
          return
        }
        if (tryVisionFallback(err.message)) return
        // 尝试重试网络错误（包括 socket hang up）
        if (!tryRetry(err.message, doRequest)) {
          getAiDebugService().logResponseError(reqId, err.message)
          const friendly = tryFriendlyApiError(err, profile.model)
          complete(() => onError(friendly || t('error.request_error', { message: translateNetworkError(err.message) })))
        }
      })

      // 支持中止请求
      abortController.signal.addEventListener('abort', () => {
        req?.destroy()
        const filteredCount = toolCalls.length
        const validToolCalls = toolCalls.filter(tc => {
          if (!tc.id || !tc.function.name || !tc.function.arguments) return false
          try { JSON.parse(tc.function.arguments); return true }
          catch (e) { if (e instanceof SyntaxError) return false; throw e }
        })
        if (validToolCalls.length < filteredCount) {
          log.info(`Abort: filtered ${filteredCount - validToolCalls.length}/${filteredCount} incomplete tool_calls`)
        }
        if (!isCompleted && hasReasoningOutput && !hasContentOutput) {
          onChunk('\n\n</blockquote>\n</details>')
        }
        const hasValidTools = validToolCalls.length > 0
        const finalContent = content || (!hasValidTools && reasoningContent ? `<details>\n<summary>🤔 <strong>${t('ai.thinking_process')}</strong></summary>\n\n<blockquote>\n\n${reasoningContent}\n\n</blockquote>\n</details>` : undefined)
        complete(() => onDone({
          content: finalContent,
          tool_calls: hasValidTools ? validToolCalls : undefined,
          finish_reason: 'stop',
          reasoning_content: hasReasoningOutput ? reasoningContent : undefined
        }))
      })

      const toolStreamBody = isAnthropic ? convertToAnthropicBody(requestBody as Record<string, unknown>) : requestBody
      req.write(JSON.stringify(toolStreamBody))
      req.end()
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      if (tryVisionFallback(errorMsg)) return
      // 尝试重试网络错误
      if (!tryRetry(errorMsg, doRequest)) {
        getAiDebugService().logResponseError(reqId, `Exception: ${errorMsg}`)
        if (error instanceof Error) {
          const friendly = tryFriendlyApiError(error, profile.model)
          complete(() => onError(friendly || t('error.ai_request_failed', { message: translateNetworkError(error.message) })))
        } else {
          complete(() => onError(t('error.ai_request_failed_unknown')))
        }
      }
    }
    }  // end of doRequest

    // 开始执行请求
    doRequest()
  }

  /**
   * 生成命令解释的 prompt
   */
  static getExplainCommandPrompt(command: string): AiMessage[] {
    return [
      {
        role: 'system',
        content:
          '你是一个专业的 Linux/Unix 系统管理员助手。用户会给你一个命令，请用中文简洁地解释这个命令的作用、参数含义，以及可能的注意事项。'
      },
      {
        role: 'user',
        content: `请解释这个命令：\n\`\`\`\n${command}\n\`\`\``
      }
    ]
  }

  /**
   * 生成错误诊断的 prompt
   */
  static getDiagnoseErrorPrompt(error: string, context?: string): AiMessage[] {
    return [
      {
        role: 'system',
        content:
          '你是一个专业的运维工程师助手。用户会给你一个错误信息，请用中文分析错误原因，并提供可能的解决方案。'
      },
      {
        role: 'user',
        content: `请分析这个错误并提供解决方案：\n\`\`\`\n${error}\n\`\`\`${context ? `\n\n上下文信息：\n${context}` : ''}`
      }
    ]
  }

  /**
   * 生成自然语言转命令的 prompt
   */
  static getNaturalToCommandPrompt(description: string, os?: string): AiMessage[] {
    return [
      {
        role: 'system',
        content: `你是一个专业的命令行助手。用户会用自然语言描述他想做的事情，请生成对应的命令。${os ? `当前操作系统是 ${os}。` : ''}请只返回命令本身，如果有多个命令请用换行分隔，不需要额外解释。`
      },
      {
        role: 'user',
        content: description
      }
    ]
  }
}

