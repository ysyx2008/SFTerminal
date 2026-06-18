/**
 * Web Fetch 服务
 *
 * 为 Agent 提供"拉一个 URL → LLM 友好的文本/markdown"能力，覆盖三种场景：
 * - 静态 HTML（博客 / 文档 / 维基）：本地 jsdom + Mozilla Readability 提取正文
 * - SPA 渲染页面（Notion 公开页 / 飞书 API 文档 / 现代 SaaS docs）：必须经过
 *   headless 浏览器才能拿到内容，本服务自动调用 Jina Reader API（要求用户在
 *   web-search 设置里配 Jina key）
 * - 纯文本 / JSON / Markdown：直接返回原始内容
 *
 * 二进制文件（PDF / 图片 / 视频 / zip）不由本服务处理——Agent 应改为先用 exec
 * 把文件下载到本地，再用 read_file（PDF 走 document-parser）解析。
 *
 * 安全约束：
 * - 仅允许 http/https；
 * - 拒绝 loopback / RFC1918 / link-local / 云元数据 IP（SSRF 防护——LLM 是
 *   不可信源，不能让它能访问内网或本机服务）；
 * - AbortSignal.timeout 覆盖**所有网络 I/O**（headers + body 流式读取 +
 *   错误预览读取），防"headers 快、body 慢速饿死"攻击。**注意**：同步的
 *   Readability/HTML 解析阶段不在 signal 控制范围内（Readability 没有 abort
 *   接口）；解析时间通过限制 max_bytes 间接控制（输入越小越快）。
 *
 * 设计要点：
 * - jsdom + Readability 用 lazy import，不影响 main 进程启动
 * - jsdom 在主进程同步执行，对 1MB HTML 占用 ~10-25MB 内存 + 数百 ms CPU；
 *   默认 max_bytes 设 3MB（覆盖绝大多数长文档 / Confluence / Notion 公开页 /
 *   现代 SaaS docs SPA 渲染产物），上限 10MB 留给极端页面
 * - 流式读取 + Content-Length 检查，超过 max_bytes 立即中断
 * - charset：从 response content-type 解析；UTF-8 走 TextDecoder，其他
 *   （GBK / Shift_JIS / Big5 等）lazy import iconv-lite 解码；不识别就回落
 *   到 UTF-8。目前不嗅探 <meta charset>，绝大多数现代 HTTP 服务器会正确
 *   返回 charset。
 */
import { createLogger } from '../utils/logger'
import { extractArticleFromHtml, MIN_READABILITY_CHARS } from '../utils/readability-extract'
import { getApiKey } from './web-search'
import { Buffer } from 'buffer'

const log = createLogger('WebFetch')

const DEFAULT_TIMEOUT_SEC = 30
const MAX_TIMEOUT_SEC = 60
// 主进程跑 jsdom，HTML 越大 CPU 阻塞越久。3MB 能覆盖绝大多数长文档（含 Confluence
// / Notion 公开页 / SaaS docs SPA 渲染产物）；上限 10MB 留给极端长页面。
// 提示：jsdom 处理 3MB HTML 大约 30-75MB 内存 + 1-3s CPU，已是可接受范围。
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024     // 3MB
const MAX_MAX_BYTES = 10 * 1024 * 1024        // 10MB
const TEXT_OUTPUT_TRUNCATE = 16_000           // 返回给 Agent 的文本上限
const ERROR_PREVIEW_BYTES = 8 * 1024          // 错误响应体最多读 8KB 用于预览

const JINA_READER_BASE = 'https://r.jina.ai/'

// 浏览器样 User-Agent，部分网站会拒绝 Node fetch 默认 UA
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export interface WebFetchOptions {
  url: string
  /** 总耗时上限，秒 */
  timeoutSec?: number
  /** 响应体大小上限，字节 */
  maxBytes?: number
  /** 强制走指定后端（默认 'auto'：有 Jina key 走 jina，否则 readability） */
  backend?: 'auto' | 'jina' | 'readability' | 'raw'
}

export type WebFetchBackend = 'jina' | 'readability' | 'raw' | 'fallback-text'

export interface WebFetchResult {
  url: string
  /** 最终生效的 URL（重定向后） */
  finalUrl: string
  status: number
  contentType: string
  /** 流上累计的真实字节数（截断时 > maxBytes，反映目标资源的真实体积） */
  bytes: number
  /** 提取后的文本/markdown 内容（已截断到 TEXT_OUTPUT_TRUNCATE） */
  content: string
  /** 标题（HTML 提取出来的，用于卡片展示） */
  title?: string
  /** 内容是否被截断（含 size 上限和最终输出截断两种情况） */
  truncated: boolean
  /** 实际使用的提取后端 */
  backend: WebFetchBackend
}

/** Jina Reader API 是否可用（用户在 web-search 配了 jina key） */
export function jinaAvailable(): boolean {
  // 即便用户当前 provider 不是 jina，只要配了 jina 的 key 就能用
  return !!getApiKey('jina')
}

/**
 * 主入口：抓取并提取
 */
export async function webFetch(opts: WebFetchOptions): Promise<WebFetchResult> {
  const normalized = normalizeUrl(opts.url)
  await ensureNotInternal(normalized)

  const timeoutSec = clamp(opts.timeoutSec, DEFAULT_TIMEOUT_SEC, 1, MAX_TIMEOUT_SEC)
  const maxBytes = clamp(opts.maxBytes, DEFAULT_MAX_BYTES, 1024, MAX_MAX_BYTES)

  const backend: 'jina' | 'readability' | 'raw' = (() => {
    if (opts.backend === 'jina' || opts.backend === 'readability' || opts.backend === 'raw') {
      return opts.backend
    }
    return jinaAvailable() ? 'jina' : 'readability'
  })()

  if (backend === 'jina') {
    try {
      return await fetchViaJina(normalized, timeoutSec, maxBytes)
    } catch (e) {
      log.warn(`Jina fetch failed for ${normalized}, falling back to readability:`, e)
      return await fetchAndExtract(normalized, timeoutSec, maxBytes, 'readability')
    }
  }
  return await fetchAndExtract(normalized, timeoutSec, maxBytes, backend)
}

// ============================================================================
// Jina Reader 路径
// ============================================================================

async function fetchViaJina(
  url: string,
  timeoutSec: number,
  maxBytes: number
): Promise<WebFetchResult> {
  const apiKey = getApiKey('jina')
  // 显式提示：让 backend='jina' 在没配 key 时给出可读的错误，而不是发空 token 收 401
  if (!apiKey) {
    throw new Error('Jina backend requested but no Jina API key configured (web-search settings)')
  }
  // url 已规范化（normalizeUrl），直接拼接安全
  const reqUrl = `${JINA_READER_BASE}${url}`

  // AbortSignal.timeout 覆盖**所有网络 I/O**（headers + body 读取），与
  // web-search providers 一致。不覆盖后续同步的 Readability 解析（见文件头注释）。
  const signal = AbortSignal.timeout(timeoutSec * 1000)

  const resp = await fetch(reqUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'text/markdown',
    },
    signal,
  })

  if (!resp.ok) {
    // 关键：错误响应体也必须限流，否则故障/恶意服务返回 500 + 500MB body
    // 会被 resp.text() 全读进内存。
    const text = await readBodyPreview(resp)
    throw new Error(`Jina Reader returned ${resp.status}: ${text.slice(0, 300)}`)
  }

  const { text, bytes, truncated } = await readBodyWithLimit(resp, maxBytes, 'utf-8')
  const finalContent = truncate(text, TEXT_OUTPUT_TRUNCATE)

  // Jina 的 markdown 输出通常以 "Title: ..." 开头，提取作为标题
  let title: string | undefined
  const titleMatch = /^Title:\s*(.+)$/m.exec(finalContent)
  if (titleMatch) title = titleMatch[1].trim()

  return {
    url,
    finalUrl: url,
    status: resp.status,
    contentType: resp.headers.get('content-type') || 'text/markdown',
    bytes,
    content: finalContent,
    title,
    truncated: truncated || text.length > TEXT_OUTPUT_TRUNCATE,
    backend: 'jina',
  }
}

// ============================================================================
// 直接 fetch + Readability 路径
// ============================================================================

const MAX_REDIRECTS = 10

/**
 * 手动跟随重定向，每跳之前做 SSRF 校验。
 *
 * 为什么不能用 `redirect: 'follow'`：fetch 静默跟随重定向，等我们拿到 response
 * 时请求早已发到攻击目标（如 `attacker.com → 302 → 169.254.169.254`），
 * 即使最后我们拒绝返回内容，凭据已经离开本机/副作用已经发生。
 */
async function fetchWithSafeRedirect(url: string, signal: AbortSignal): Promise<Response> {
  let currentUrl = url
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const resp = await fetch(currentUrl, {
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml,text/plain,application/json;q=0.9,*/*;q=0.5',
      },
      signal,
      redirect: 'manual',
    })

    // 3xx：手动跳。简单 GET 场景不区分 302/303/307/308 语义
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location')
      if (!loc) return resp  // 无 Location 头，让上层按 3xx 处理（!ok 会抛错）
      try { resp.body?.cancel() } catch { /* ignore */ }

      // Location 可能是相对 URL，按当前 URL 解析
      let nextUrl: string
      try {
        nextUrl = new URL(loc, currentUrl).toString()
      } catch {
        throw new Error(`Invalid redirect Location "${loc}" from ${currentUrl}`)
      }

      const parsed = new URL(nextUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Blocked redirect to non-http(s) protocol: ${parsed.protocol}`)
      }
      // 关键：每跳之前 SSRF 校验，防止 attacker.com → 302 → 内网
      await ensureNotInternal(nextUrl)
      currentUrl = nextUrl
      continue
    }

    return resp
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting from ${url}`)
}

async function fetchAndExtract(
  url: string,
  timeoutSec: number,
  maxBytes: number,
  backend: 'readability' | 'raw'
): Promise<WebFetchResult> {
  const signal = AbortSignal.timeout(timeoutSec * 1000)

  const resp = await fetchWithSafeRedirect(url, signal)
  const finalUrl = resp.url || url

  const contentType = (resp.headers.get('content-type') || '').toLowerCase()

  if (!resp.ok) {
    // 关键：错误响应体也必须限流（见 fetchViaJina 同处注释）
    const peek = await readBodyPreview(resp)
    throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}: ${peek.slice(0, 200)}`)
  }

  if (isBinaryContentType(contentType)) {
    // 二进制：拒绝处理。错误消息里**不嵌可执行 shell 片段**，避免 LLM 拼坏的 URL
    // 直接复制粘贴执行（URL 含特殊字符时单引号转义会出错）
    throw new Error(
      `Binary content (${contentType}) is not supported by web_fetch. ` +
      `Please download the file to local first via exec (use curl -L with proper quoting), ` +
      `then read it with read_file (which supports PDF / images via document-parser).`
    )
  }

  const charset = parseCharset(contentType)
  const { text: rawText, bytes, truncated } = await readBodyWithLimit(resp, maxBytes, charset)

  // JSON：尝试美化输出
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    let pretty = rawText
    try { pretty = JSON.stringify(JSON.parse(rawText), null, 2) } catch { /* 保留原文 */ }
    return {
      url,
      finalUrl,
      status: resp.status,
      contentType,
      bytes,
      content: truncate(pretty, TEXT_OUTPUT_TRUNCATE),
      truncated: truncated || pretty.length > TEXT_OUTPUT_TRUNCATE,
      backend: 'raw',
    }
  }

  // 纯文本 / markdown / 其他 text/*
  if (contentType.startsWith('text/') && !contentType.includes('html')) {
    return {
      url,
      finalUrl,
      status: resp.status,
      contentType,
      bytes,
      content: truncate(rawText, TEXT_OUTPUT_TRUNCATE),
      truncated: truncated || rawText.length > TEXT_OUTPUT_TRUNCATE,
      backend: 'raw',
    }
  }

  // backend=raw：HTML 也直接返回原始（少用，主要给测试 / debug 用）
  if (backend === 'raw') {
    return {
      url,
      finalUrl,
      status: resp.status,
      contentType,
      bytes,
      content: truncate(rawText, TEXT_OUTPUT_TRUNCATE),
      truncated: truncated || rawText.length > TEXT_OUTPUT_TRUNCATE,
      backend: 'raw',
    }
  }

  // 关键：走到这里前已经处理了 JSON / text/non-html / raw 三种情况，
  // 但 isBinaryContentType 把 application/xml、application/javascript、
  // application/x-yaml、application/x-www-form-urlencoded 等"文本型 application/*"
  // 也放过来（不算二进制）。这些不是 HTML，不能进 Readability——否则 XML
  // 会被当 HTML 解析、YAML 里的 < > 会被当标签剥掉。这里再加一道闸：
  // 只有 content-type 含 html 才走 Readability，其余按 raw 返回。
  if (!contentType.includes('html')) {
    return {
      url,
      finalUrl,
      status: resp.status,
      contentType,
      bytes,
      content: truncate(rawText, TEXT_OUTPUT_TRUNCATE),
      truncated: truncated || rawText.length > TEXT_OUTPUT_TRUNCATE,
      backend: 'raw',
    }
  }

  // HTML：走 Readability；失败 fallback 到简单文本提取（保不丢内容）
  return await extractHtml(url, finalUrl, resp.status, contentType, bytes, rawText, truncated)
}

async function extractHtml(
  url: string,
  finalUrl: string,
  status: number,
  contentType: string,
  bytes: number,
  rawHtml: string,
  truncatedAtRead: boolean
): Promise<WebFetchResult> {
  try {
    const article = await extractArticleFromHtml(rawHtml, finalUrl)
    if (article && article.textContent && article.textContent.trim().length > MIN_READABILITY_CHARS) {
      const body = article.textContent.trim()
      const out = article.title
        ? `# ${article.title}\n\n${body}`
        : body
      return {
        url,
        finalUrl,
        status,
        contentType,
        bytes,
        content: truncate(out, TEXT_OUTPUT_TRUNCATE),
        title: article.title || undefined,
        truncated: truncatedAtRead || out.length > TEXT_OUTPUT_TRUNCATE,
        backend: 'readability',
      }
    }
    log.warn(`Readability returned empty/short content for ${url}, falling back to plain text`)
  } catch (e) {
    log.warn(`Readability failed for ${url}, falling back to plain text:`, e)
  }

  const fallback = simpleHtmlToText(rawHtml)
  return {
    url,
    finalUrl,
    status,
    contentType,
    bytes,
    content: truncate(fallback.text, TEXT_OUTPUT_TRUNCATE),
    title: fallback.title,
    truncated: truncatedAtRead || fallback.text.length > TEXT_OUTPUT_TRUNCATE,
    backend: 'fallback-text',
  }
}

/**
 * Fallback：极简 HTML → 文本提取
 * 没有依赖，作用是 Readability 罢工时也能拿到点东西，质量不高但不丢内容
 */
function simpleHtmlToText(html: string): { title?: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : undefined

  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')

  cleaned = cleaned
    .replace(/<\/(p|div|li|h[1-6]|tr|br|hr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')

  cleaned = cleaned.replace(/<[^>]+>/g, ' ')

  cleaned = decodeEntities(cleaned)

  cleaned = cleaned
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')

  return { title, text: cleaned }
}

/** 解码常见 HTML 实体（不依赖第三方） */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = parseInt(code, 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const n = parseInt(hex, 16)
      return Number.isFinite(n) ? String.fromCodePoint(n) : ''
    })
}

// ============================================================================
// 通用工具
// ============================================================================

/**
 * 流式读取响应体并强制 size 上限。Content-Length 已知就用 Content-Length，
 * 否则边读边累计字节数，超过立刻中断（防止拉视频文件）。
 *
 * 字节累积成 Buffer 后用 iconv-lite 按 charset 解码（支持 GBK/Shift_JIS/Big5 等）。
 * UTF-8 走 TextDecoder（无需引入 iconv 解码 fast path）。
 */
async function readBodyWithLimit(
  resp: Response,
  maxBytes: number,
  charset: string
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const contentLength = parseInt(resp.headers.get('content-length') || '', 10)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    try { resp.body?.cancel() } catch { /* ignore */ }
    throw new Error(`Response too large: Content-Length ${contentLength} > max ${maxBytes}`)
  }

  if (!resp.body) {
    return { text: '', bytes: 0, truncated: false }
  }

  const reader = resp.body.getReader()
  const buffers: Uint8Array[] = []
  let total = 0
  let truncated = false

  try {
    let chunk = await reader.read()
    while (!chunk.done) {
      const value = chunk.value
      total += value.byteLength
      if (total > maxBytes) {
        // 截断：保留到 maxBytes 就够（多余部分丢掉）
        const overflow = total - maxBytes
        const usable = value.byteLength - overflow
        if (usable > 0) {
          buffers.push(value.subarray(0, usable))
        }
        truncated = true
        try { reader.cancel() } catch { /* ignore */ }
        break
      }
      buffers.push(value)
      chunk = await reader.read()
    }
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }

  const realBytes = truncated ? maxBytes : total
  const merged = Buffer.concat(buffers, realBytes)

  // UTF-8 走 TextDecoder（不必加载 iconv-lite）
  const cs = charset.toLowerCase()
  if (cs === 'utf-8' || cs === 'utf8' || cs === '') {
    return {
      text: new TextDecoder('utf-8', { fatal: false }).decode(merged),
      bytes: total,
      truncated,
    }
  }

  // 非 UTF-8：lazy import iconv-lite（绝大多数页面是 UTF-8，没必要每次都加载）
  try {
    const { default: iconv } = await import('iconv-lite')
    if (iconv.encodingExists(cs)) {
      return {
        text: iconv.decode(merged, cs),
        bytes: total,
        truncated,
      }
    }
    log.warn(`Unsupported charset "${charset}", falling back to utf-8`)
  } catch (e) {
    log.warn(`iconv-lite decode failed for charset "${charset}":`, e)
  }
  return {
    text: new TextDecoder('utf-8', { fatal: false }).decode(merged),
    bytes: total,
    truncated,
  }
}

/**
 * 读取错误响应体作为预览，UTF-8 解码，最多 ERROR_PREVIEW_BYTES 字节。
 *
 * 单独存在的原因：错误路径不能用 readBodyWithLimit（那个走完整 charset
 * 流程，过重）；也绝不能用 resp.text()（无大小限制，500MB body 直接 OOM）。
 * 静默吞掉所有错误——错误预览失败不该让"整个 fetch 失败"的报错丢失原因。
 */
async function readBodyPreview(resp: Response): Promise<string> {
  // body 为 null 时 stream 不可用（fetch polyfill 或某些 mock 场景），fallback
  // 到 resp.text()——这种情况下没有"无限大流"风险，只能是 buffered 完整 body
  if (!resp.body) {
    try {
      const text = await resp.text()
      return text.slice(0, ERROR_PREVIEW_BYTES)
    } catch {
      return ''
    }
  }
  const reader = resp.body.getReader()
  const buffers: Uint8Array[] = []
  let total = 0
  try {
    while (total < ERROR_PREVIEW_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = ERROR_PREVIEW_BYTES - total
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value
      buffers.push(slice)
      total += slice.byteLength
    }
    try { reader.cancel() } catch { /* ignore */ }
    return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(buffers, total))
  } catch {
    return ''
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }
}

/** 从 content-type 提取 charset（未声明返回空串，调用方按 utf-8 处理） */
function parseCharset(contentType: string): string {
  // RFC 2616: `text/html; charset=GBK; foo=bar`
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)
  return m ? m[1] : ''
}

function isBinaryContentType(ct: string): boolean {
  if (!ct) return false
  if (ct.startsWith('text/')) return false
  if (ct.includes('json')) return false
  if (ct.includes('xml')) return false
  if (ct.includes('javascript') || ct.includes('ecmascript')) return false
  if (ct.startsWith('image/')) return true
  if (ct.startsWith('audio/')) return true
  if (ct.startsWith('video/')) return true
  if (ct.startsWith('application/')) {
    if (
      ct.includes('json') ||
      ct.includes('xml') ||
      ct.includes('javascript') ||
      ct.includes('ecmascript') ||
      ct.includes('x-yaml') ||
      ct.includes('x-www-form-urlencoded')
    ) return false
    return true
  }
  return false
}

/**
 * URL 校验 + 规范化。仅允许 http/https 协议；返回 new URL().toString() 的标准形式。
 */
function normalizeUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http/https URLs are supported, got: ${parsed.protocol}`)
  }
  return parsed.toString()
}

/**
 * SSRF 防护：拒绝指向 loopback / 私有 / 链路本地 / 云元数据等内部地址的 URL。
 *
 * LLM 是不可信源（用户可能用 prompt injection 让 Agent 调
 * `web_fetch("http://169.254.169.254/...")` 拿云凭据），必须在 fetch 之前拦截。
 *
 * 当前策略：仅判断 hostname 字面量是不是 IP 或公认的本地名（localhost / *.localhost / *.internal）。
 * 不做 dns.lookup（避免增加延迟，也避免 DNS rebind 在 lookup 和 fetch 之间窗口被利用——
 * 实际防御 rebind 需要 fetch 时把解析结果钉死，这超出当前范围；目前已经能挡住绝大多数
 * "LLM 直接给一个内网 IP / localhost"的场景）。
 */
async function ensureNotInternal(url: string): Promise<void> {
  const parsed = new URL(url)
  const host = parsed.hostname.toLowerCase()

  // 字面 hostname 黑名单
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error(`Blocked: hostname "${host}" resolves to a local/internal target (SSRF protection)`)
  }

  // 字面 IP 检测
  if (isInternalIp(host)) {
    throw new Error(`Blocked: hostname "${host}" is an internal IP address (SSRF protection)`)
  }

  // 注：未做 DNS 解析。如果未来需要严格防 DNS rebind，需要在 fetch 时 pin 解析结果，
  // 那需要替换 fetch 实现（如改用 undici 自定义 connect），代价较大且会破坏 redirect。
  // 当前威胁模型：LLM 主要威胁是直接给内网 IP / localhost——已挡住。
}

/**
 * 是否内部 IP（IPv4 + IPv6 常见私有段 + 云元数据 IP）。
 *
 * 关键依赖：调用方传入的 host 必须是 `new URL(...).hostname`——WHATWG URL 解析器
 * 会自动把 IPv4 的 8 进制 / 16 进制 / 单整数 / 短段 等表示规范化为标准点分十进制
 * （已在 ensureNotInternal 中保证），所以这里的字符串正则就够了：
 *   - http://2130706433/      → hostname "127.0.0.1"
 *   - http://017700000001/    → hostname "127.0.0.1"
 *   - http://0x7f.0.0.1/      → hostname "127.0.0.1"
 *   - http://127.0.1/         → hostname "127.0.0.1"
 *
 * IPv6 hostname 由 URL 解析器输出 hex 压缩形式（带 `[]`），如
 * `[::ffff:7f00:1]`（IPv4-mapped 形式 ::ffff:127.0.0.1）。我们必须识别这种 hex
 * 形式的 IPv4-mapped 段，并从 hex 还原回 IPv4 octets 再判断。
 */
function isInternalIp(host: string): boolean {
  // 去掉 IPv6 的方括号
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host

  // IPv4 标准点分十进制（URL 解析器已规范化）
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const a = parseInt(v4[1], 10)
    const b = parseInt(v4[2], 10)
    if ([a, b, parseInt(v4[3], 10), parseInt(v4[4], 10)].some(n => n < 0 || n > 255)) return false
    return isInternalV4(a, b)
  }

  // IPv6
  if (h.includes(':')) {
    const lower = h.toLowerCase()
    if (lower === '::' || lower === '::1') return true                          // unspecified / loopback
    if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true    // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true           // ULA fc00::/7
    // IPv4-mapped IPv6（::ffff:a.b.c.d 或被规范化的 ::ffff:hex:hex）
    const mapped = parseIPv4MappedIPv6(lower)
    if (mapped) return isInternalV4(mapped[0], mapped[1])
    return false
  }

  return false
}

/** 共享 IPv4 段判定逻辑（也用于 IPv4-mapped IPv6 解出来的 octets） */
function isInternalV4(a: number, b: number): boolean {
  if (a === 0) return true                          // 0.0.0.0/8
  if (a === 10) return true                         // 10.0.0.0/8
  if (a === 127) return true                        // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true           // 169.254.0.0/16 link-local（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true  // 172.16.0.0/12
  if (a === 192 && b === 168) return true           // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  return false
}

/**
 * 解析 IPv4-mapped IPv6（::ffff:x.y.z.w 或 ::ffff:hexA:hexB）。
 * 返回 [a, b, c, d] 或 null。
 *
 * 必须处理 hex 形式：URL 解析器把 `::ffff:127.0.0.1` 规范化为 `::ffff:7f00:1`
 * （hostname 输出），所以光识别带点形式还会漏。
 */
function parseIPv4MappedIPv6(lower: string): [number, number, number, number] | null {
  if (!lower.startsWith('::ffff:')) return null
  const tail = lower.slice(7)

  // 形式 1: ::ffff:a.b.c.d
  const dot = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tail)
  if (dot) {
    const a = parseInt(dot[1], 10)
    const b = parseInt(dot[2], 10)
    const c = parseInt(dot[3], 10)
    const d = parseInt(dot[4], 10)
    if ([a, b, c, d].some(n => n < 0 || n > 255)) return null
    return [a, b, c, d]
  }

  // 形式 2: ::ffff:HEX1:HEX2，HEX1=高 16 位，HEX2=低 16 位
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
  if (hex) {
    const high = parseInt(hex[1], 16)
    const low = parseInt(hex[2], 16)
    if (!Number.isFinite(high) || !Number.isFinite(low)) return null
    return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff]
  }

  return null
}

function clamp(raw: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.max(raw, min), max)
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n\n…[truncated, original length ${s.length}]`
}

// 导出给上层 / 测试用
export const _internal = {
  isBinaryContentType,
  simpleHtmlToText,
  decodeEntities,
  normalizeUrl,
  parseCharset,
  isInternalIp,
  ensureNotInternal,
}
