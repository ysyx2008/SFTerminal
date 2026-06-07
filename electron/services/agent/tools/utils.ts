/**
 * 工具执行器通用工具函数
 */
import { t } from '../i18n'
import type { ErrorCategory, ToolExecutorConfig, ToolResult } from './types'
import { PATH_PARAM_NAMES } from './types'
import { createLogger } from '../../../utils/logger'

const log = createLogger('ToolUtils')

/**
 * 分析错误类型
 */
export function categorizeError(error: string): ErrorCategory {
  const errorLower = error.toLowerCase()
  
  // 暂时性错误（可重试）
  if (errorLower.includes('connection reset') ||
      errorLower.includes('network') ||
      errorLower.includes('temporarily') ||
      errorLower.includes('busy') ||
      errorLower.includes('try again')) {
    return 'transient'
  }
  
  // 权限错误
  if (errorLower.includes('permission denied') ||
      errorLower.includes('access denied') ||
      errorLower.includes('not permitted') ||
      errorLower.includes('operation not allowed')) {
    return 'permission'
  }
  
  // 资源不存在
  if (errorLower.includes('not found') ||
      errorLower.includes('no such file') ||
      errorLower.includes('does not exist') ||
      errorLower.includes('command not found')) {
    return 'not_found'
  }
  
  // 超时
  if (errorLower.includes('timeout') ||
      errorLower.includes('timed out')) {
    return 'timeout'
  }
  
  return 'fatal'
}

/**
 * 获取错误恢复建议
 */
export function getErrorRecoverySuggestion(error: string, category: ErrorCategory): string {
  switch (category) {
    case 'transient':
      return t('error.transient')
    case 'permission':
      return t('error.permission')
    case 'not_found':
      return t('error.not_found')
    case 'timeout':
      return t('error.timeout')
    case 'fatal':
      return t('error.execution_failed')
  }
}

/**
 * 带重试的异步执行
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number
    retryDelay?: number
    shouldRetry?: (error: Error) => boolean
  } = {}
): Promise<T> {
  const { maxRetries = 2, retryDelay = 1000, shouldRetry } = options
  
  let lastError: Error | null = null
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error
      
      // 检查是否应该重试
      if (attempt < maxRetries) {
        const category = categorizeError(lastError.message)
        const canRetry = category === 'transient' || category === 'timeout'
        
        if (shouldRetry ? shouldRetry(lastError) : canRetry) {
          // 指数退避
          const delay = retryDelay * Math.pow(2, attempt)
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }
      }
      
      throw lastError
    }
  }
  
  throw lastError
}

/**
 * 从后向前截断字符串，保留最新的内容
 */
export function truncateFromEnd(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  
  // 按行分割，从后向前保留行
  const lines = text.split('\n')
  const result: string[] = []
  let currentLength = 0
  const ellipsisLength = 3 // '...' 的长度
  const availableLength = maxLength - ellipsisLength
  
  // 从最后一行开始向前累积
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const isLastLine = i === lines.length - 1
    
    const lineLength = isLastLine ? line.length : line.length + 1
    const neededLength = currentLength + lineLength
    
    if (neededLength > availableLength) {
      if (isLastLine && currentLength === 0) {
        const truncatedLine = line.slice(-availableLength)
        result.unshift(truncatedLine)
        return '...' + truncatedLine
      }
      break
    }
    
    result.unshift(line)
    currentLength += lineLength
  }
  
  if (result.length < lines.length) {
    return '...' + result.join('\n')
  }
  
  return result.join('\n')
}

export interface TruncateFromEndResult {
  text: string
  truncated: boolean
  originalLength: number
  shownLength: number
}

export interface TruncateSandwichStats {
  headChars: number
  tailChars: number
  omittedLines: number
  omittedChars: number
}

export interface TruncateSandwichResult extends TruncateFromEndResult, TruncateSandwichStats {}

const SANDWICH_GAP = '\n...\n'

/** 单行超过此长度（相对预算）时按字符头尾截断，而非整行保留 */
function longLineThreshold(maxLength: number): number {
  return Math.max(256, Math.floor(maxLength / 4))
}

/** 在 budget 内对超长行做字符级头尾保留 */
function truncateLongLine(line: string, budget: number): string {
  if (line.length <= budget) return line
  if (budget <= 6) return line.slice(0, Math.max(0, budget))
  const marker = '...'
  const side = Math.floor((budget - marker.length) / 2)
  if (side <= 0) return marker.slice(0, budget)
  return line.slice(0, side) + marker + line.slice(-side)
}

function countNewlines(text: string): number {
  if (!text) return 0
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') count++
  }
  return count
}

/** 字符级头尾 sandwich（用于单行 / 行 sandwich 放不下时） */
function truncateCharSandwich(text: string, maxLength: number): TruncateSandwichResult {
  const originalLength = text.length
  const gapLen = SANDWICH_GAP.length
  const bodyBudget = Math.max(0, maxLength - gapLen)
  const half = Math.floor(bodyBudget / 2)
  const head = text.slice(0, half)
  const tail = text.slice(originalLength - half)
  const body = head + SANDWICH_GAP + tail
  const omittedChars = Math.max(0, originalLength - head.length - tail.length)
  return {
    text: body,
    truncated: true,
    originalLength,
    shownLength: body.length,
    headChars: head.length,
    tailChars: tail.length,
    omittedLines: countNewlines(text.slice(head.length, originalLength - tail.length)),
    omittedChars,
  }
}

interface LineSegment {
  lines: string[]
  /** 在原始 lines 数组中占用的最后一行 index（inclusive） */
  endIndex: number
  length: number
}

/** 从开头按行累积，直到超出 halfBudget；遇超长行则行内字符截断 */
function takeHeadLines(lines: string[], halfBudget: number): LineSegment {
  const picked: string[] = []
  let used = 0
  let endIndex = -1
  const threshold = longLineThreshold(halfBudget * 2)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const sep = picked.length > 0 ? 1 : 0
    const thresholdHit = line.length > threshold

    if (thresholdHit) {
      const remaining = halfBudget - used - sep
      if (remaining > 0) {
        picked.push(truncateLongLine(line, remaining))
        used += sep + picked[picked.length - 1].length
      }
      endIndex = i
      break
    }

    const add = line.length + sep
    if (used + add > halfBudget) break

    picked.push(line)
    used += add
    endIndex = i
  }

  return { lines: picked, endIndex, length: used }
}

/** 从末尾按行累积；minIndex 为 head 已占用的最后一行 index */
function takeTailLines(lines: string[], halfBudget: number, minIndex: number): LineSegment & { startIndex: number } {
  const picked: string[] = []
  let used = 0
  let startIndex = lines.length
  const threshold = longLineThreshold(halfBudget * 2)

  for (let i = lines.length - 1; i > minIndex; i--) {
    const line = lines[i]
    const sep = picked.length > 0 ? 1 : 0
    const thresholdHit = line.length > threshold

    if (thresholdHit) {
      const remaining = halfBudget - used - sep
      if (remaining > 0) {
        picked.unshift(truncateLongLine(line, remaining))
        used += sep + picked[0].length
      }
      startIndex = i
      break
    }

    const add = line.length + sep
    if (used + add > halfBudget) break

    picked.unshift(line)
    used += add
    startIndex = i
  }

  return { lines: picked, endIndex: lines.length - 1, startIndex, length: used }
}

/**
 * 按行头尾 sandwich 截断；单行或行间无法切开时回退字符级 sandwich。
 * 超长行在段内按字符头尾截断，避免整行撑爆预算。
 */
export function truncateSandwichDetailed(text: string, maxLength: number): TruncateSandwichResult {
  const originalLength = text.length
  if (originalLength <= maxLength) {
    return {
      text,
      truncated: false,
      originalLength,
      shownLength: originalLength,
      headChars: originalLength,
      tailChars: 0,
      omittedLines: 0,
      omittedChars: 0,
    }
  }

  if (!text.includes('\n')) {
    return truncateCharSandwich(text, maxLength)
  }

  const lines = text.split('\n')
  const gapLen = SANDWICH_GAP.length
  const bodyBudget = Math.max(0, maxLength - gapLen)
  const halfBudget = Math.floor(bodyBudget / 2)

  const head = takeHeadLines(lines, halfBudget)
  const tail = takeTailLines(lines, halfBudget, head.endIndex)

  if (head.lines.length === 0 && tail.lines.length === 0) {
    return truncateCharSandwich(text, maxLength)
  }

  // head/tail 行区间重叠或贴在一起 → 字符 sandwich
  if (tail.startIndex <= head.endIndex + 1) {
    return truncateCharSandwich(text, maxLength)
  }

  const headText = head.lines.join('\n')
  const tailText = tail.lines.join('\n')
  const body = headText + SANDWICH_GAP + tailText
  const omittedLineCount = tail.startIndex - head.endIndex - 1
  const shownChars = headText.length + tailText.length
  const omittedChars = Math.max(0, originalLength - shownChars)

  return {
    text: body,
    truncated: true,
    originalLength,
    shownLength: body.length,
    headChars: headText.length,
    tailChars: tailText.length,
    omittedLines: omittedLineCount,
    omittedChars,
  }
}

/**
 * 头尾 sandwich 截断；若发生截断，在正文前附加一行 notice。
 */
export function truncateSandwichWithNotice(
  text: string,
  maxLength: number,
  formatNotice: (stats: TruncateSandwichStats & { originalLength: number; shownLength: number }) => string
): string {
  const result = truncateSandwichDetailed(text, maxLength)
  if (!result.truncated) return result.text
  return `${formatNotice(result)}\n${result.text}`
}

/**
 * 从后向前截断，并返回是否截断及原始长度（供 exec 等工具附加元信息）。
 */
export function truncateFromEndDetailed(text: string, maxLength: number): TruncateFromEndResult {
  const originalLength = text.length
  if (originalLength <= maxLength) {
    return { text, truncated: false, originalLength, shownLength: originalLength }
  }
  const truncatedText = truncateFromEnd(text, maxLength)
  return {
    text: truncatedText,
    truncated: true,
    originalLength,
    shownLength: truncatedText.length,
  }
}

/**
 * 从后向前截断；若发生截断，在正文前附加一行 notice。
 */
export function truncateFromEndWithNotice(
  text: string,
  maxLength: number,
  formatNotice: (originalLength: number, shownLength: number) => string
): string {
  const result = truncateFromEndDetailed(text, maxLength)
  if (!result.truncated) return result.text
  return `${formatNotice(result.originalLength, result.shownLength)}\n${result.text}`
}

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * 格式化剩余时间显示
 */
export function formatRemainingTime(totalSeconds: number, elapsedSeconds: number): string {
  const remaining = Math.max(0, totalSeconds - elapsedSeconds)
  const minutes = Math.floor(remaining / 60)
  const seconds = remaining % 60
  
  if (minutes > 0) {
    return t('time.minutes_seconds', { minutes, seconds })
  }
  return t('time.seconds', { seconds })
}

/**
 * 格式化总时间显示
 */
export function formatTotalTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  
  if (minutes > 0) {
    return secs > 0 ? t('time.minutes_seconds', { minutes, seconds: secs }) : t('time.minutes', { minutes })
  }
  return t('time.seconds', { seconds })
}

/**
 * 解码 Python 风格的 \xXX 转义序列（仅用于路径参数）
 */
export function tryDecodePythonEscapesForPath(str: string): string {
  if (!str.includes('\\x')) {
    return str
  }
  
  const looksLikePath = str.startsWith('/') || str.startsWith('~') || /^[A-Z]:[/\\]/i.test(str)
  if (!looksLikePath) {
    return str
  }
  
  try {
    const bytes: number[] = []
    let i = 0
    let hasEscapes = false
    
    while (i < str.length) {
      if (str[i] === '\\' && str[i + 1] === 'x' && i + 3 < str.length) {
        const hex = str.substring(i + 2, i + 4)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          const byte = parseInt(hex, 16)
          bytes.push(byte)
          hasEscapes = true
          i += 4
          continue
        }
      }
      bytes.push(str.charCodeAt(i))
      i++
    }
    
    if (!hasEscapes) {
      return str
    }
    
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
    
    // eslint-disable-next-line no-control-regex
    const hasNonAscii = /[^\x00-\x7F]/.test(decoded)
    if (!hasNonAscii) {
      return str
    }
    
    log.info(`Decoded Python escapes in path: "${str.substring(0, 50)}..." -> "${decoded.substring(0, 50)}..."`)
    return decoded
  } catch {
    return str
  }
}

/**
 * 解析终端类工具的目标 PTY ID。
 *
 * 分屏场景下 Agent 可在工具参数中传 `pane_id`（值为 list_panes 返回的 ptyId），
 * 把命令路由到指定窗格。不传则回退到 Agent 创建时锁定的默认 ptyId。
 *
 * 同时兼容 `pty_id` 别名（Agent 可能误用），写法上不限制大小写组合。
 */
export function resolveTargetPtyId(
  args: Record<string, unknown>,
  defaultPtyId: string
): string {
  const v = args.pane_id ?? args.paneId ?? args.pty_id ?? args.ptyId
  if (typeof v === 'string' && v) return v
  return defaultPtyId
}

/**
 * "窗格已不存在"工具结果，区分给 AI 看的完整描述和给用户 UI 看的简要描述。
 *
 * `error` 字段（从 ToolResult 继承）= AI 看到的完整版（含最新 panes JSON），
 * `briefError` = UI 卡片展示的一行描述（只说"目标窗格没了"，不带 JSON）。
 *
 * 这样既保证 AI 拿到足够信息一次决策（不必再调 list_panes），又避免在用户
 * 聊天界面里堆一坨 JSON 噪音——完整数据走 logger 落到日志文件。
 */
export interface PaneGoneToolResult extends ToolResult {
  briefError: string
}

/**
 * 构造"窗格已不存在"的标准 ToolResult。
 *
 * 用于底层 terminalService.write() 返回 false 或 executeInTerminal()
 * 返回 status:'no_instance' 这两条"运行时探测到窗格消失"的路径——把这种
 * 失败转成对 Agent 友好的错误。
 *
 * 不在工具入口做预先 hasInstance 校验：那是 TOCTOU + 多一道 IPC 调用，
 * 而底层 write/executeInTerminal 本身就能"诚实地告诉调用方失败"，让失败
 * 自然冒泡更可靠。
 *
 * 自动附带最新窗格列表（避免 Agent 多调一次 list_panes）：
 * 如果 executor 提供了 getCurrentPtyId（即 Agent 自己的 owner ptyId 还活着），
 * 就借此反查 tab、抓最新 panes，把列表内联到 `error` 字段里给 AI 看。
 *
 * 抓不到（owner ptyId 不存在 / 桥接不可用 / 超时）就回退到 fallback hint，
 * 提示 Agent 自己调 list_panes——保证最差情况也不会比改之前更差。
 *
 * UI 展示用 `briefError`（始终只是 baseError 一行），完整版只走 AI message
 * 和日志，不直接灌给用户 — 用户不需要看那一坨 JSON 才能理解发生了什么。
 */
export async function paneGoneResult(
  targetPtyId: string,
  executor?: ToolExecutorConfig
): Promise<PaneGoneToolResult> {
  const baseError = t('error.pane_not_found_runtime', { paneId: targetPtyId })
  const ownerPtyId = executor?.getCurrentPtyId?.()

  let detailedError = `${baseError} ${t('error.pane_not_found_runtime.fallback_hint')}`

  if (ownerPtyId) {
    try {
      // 动态 import 避免引入与 split-pane-bridge 之间潜在的循环依赖
      const { splitPaneBridge } = await import('../../split-pane-bridge.service')
      const result = await splitPaneBridge.exec({ type: 'list' }, ownerPtyId)
      if (result.ok && result.data) {
        const panesText = JSON.stringify(result.data, null, 2)
        detailedError = `${baseError}\n\n${t('error.pane_not_found_runtime.with_panes', { panes: panesText })}`
        log.info(`paneGone: targetPty=${targetPtyId}, attached panes for AI (ownerPty=${ownerPtyId})`)
      } else {
        // bridge 走通了但返回 not-ok（如 ownerPtyId 已死、tab 已关），走 fallback hint，
        // 但留个日志方便排障——否则线上只会看到 Agent 突然走 fallback 路径找不到原因
        log.warn(`paneGone: bridge returned not-ok (targetPty=${targetPtyId}, ownerPty=${ownerPtyId}): ${result.error || 'unknown'}`)
      }
    } catch (e) {
      // bridge 不可用（如非 UI 上下文 / 渲染窗口已销毁）就走 fallback
      log.warn(`paneGone: failed to fetch panes for AI (targetPty=${targetPtyId}, ownerPty=${ownerPtyId}):`, e)
    }
  }

  return {
    success: false,
    output: '',
    error: detailedError,
    briefError: baseError
  }
}

/**
 * 处理工具参数，只对路径相关参数解码 Python 转义序列
 */
export function normalizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && PATH_PARAM_NAMES.has(key.toLowerCase())) {
      result[key] = tryDecodePythonEscapesForPath(value)
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = normalizeToolArgs(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * 直接 child_process 执行的命令长度上限。
 *
 * exec/execFile 通过 argv 传递命令，不经过 PTY line discipline，
 * 实际限制是系统 ARG_MAX（macOS/Linux 至少 256KB，Windows cmd.exe 8191）。
 * 这里取 100KB 作为防误用上限：日常 oneliner 远低于此，超过这个量级
 * 几乎一定是 LLM 生成异常或应改用 write_text_file 写脚本。
 */
export const EXEC_MAX_COMMAND_LENGTH = 100_000

/**
 * PTY 终端命令长度上限。
 *
 * 终端在 canonical mode 下受 termios `MAX_CANON` 限制，超长命令会被
 * 截断/丢弃；不同平台默认值不同，按平台和模式分别给出保守阈值：
 *
 * - SSH 模式：远端 OS 通常是 Linux（MAX_CANON ≈ 4096），给 3500 留余量
 * - 本地 macOS：Darwin MAX_CANON = 1024，给 1000
 * - 本地 Linux：MAX_CANON ≈ 4096，给 3500
 * - 本地 Windows：ConPTY 无 line discipline，cmd.exe 命令行 8191 上限，给 4000
 *
 * 命令真的超过此阈值时，仍建议先 `write_text_file` 写脚本再 `bash xxx.sh`，
 * 避免被 line buffer 截断造成静默错误。
 */
export function getPtyMaxCommandLength(isSsh: boolean): number {
  if (isSsh) return 3500
  if (process.platform === 'darwin') return 1000
  if (process.platform === 'win32') return 4000
  return 3500
}
