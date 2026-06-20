/**
 * Attach 模式工具执行 — 经浏览器扩展操作用户已打开的浏览器
 */

import type { ToolResult } from '../../types'
import type { ToolExecutorConfig } from '../../tool-executor'
import type {
  BrowserBridgeRefMap,
  BrowserBridgeSnapshotResult,
} from '@shared/types/browser-bridge'
import { getBrowserBridgeService } from '../../../browser-bridge/browser-bridge.service'
import { attachTargetLabel } from '../../../browser-bridge/protocol'
import { detectGotoTabOverwrite } from '../../../browser-bridge/goto-tab'
import {
  bridgeTabsNavigate,
  bridgeTabsActivate,
  bridgeTabsQuery,
} from '../../../browser-bridge/tabs-bridge'
import {
  bridgeListTabs,
  bridgeSend,
  closeBridgeSession,
  createBridgeSession,
  getBridgeSession,
  resolveBridgeRef,
  touchBridgeSession,
} from './bridge-session'
import { selectorToHumanLabel } from './ref-label'
import { extractPageContentFromHtml } from '../../../../utils/page-content-extract'

function countRefs(refs: BrowserBridgeRefMap): { total: number; interactive: number } {
  const entries = Object.values(refs)
  return {
    total: entries.length,
    interactive: entries.filter((r) =>
      ['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox'].includes(r.role),
    ).length,
  }
}

function formatSnapshotOutput(data: BrowserBridgeSnapshotResult, tabsHint = ''): string {
  const stats = countRefs(data.refs)
  const statsLine = `[${stats.total} 个 ref, 其中 ${stats.interactive} 个可交互]`
  const snapshotNote =
    '（以下是无障碍树，非视觉页面；颜色、图标等纯视觉信息不会出现；必填项标注为 [必填]；attach 模式无法截图，需要视觉请 browser_snapshot 或 browser_launch launch 后用 browser_screenshot）'
  return `${snapshotNote}\n页面: ${data.title}\nURL: ${data.url}${tabsHint}\n${statsLine}\n\n${data.tree}`
}

export async function bridgeBrowserLaunch(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig,
  options: { auto?: boolean } = {},
): Promise<ToolResult> {
  const url = args.url as string | undefined
  const browserArg = args.browser
  const autoLabel = options.auto ? '（自动检测到浏览器助手已连接）' : ''
  executor.addStep({
    type: 'tool_call',
    content: url
      ? `连接浏览器并访问 ${url}${autoLabel}`
      : `连接当前浏览器（复用登录态与标签页）${autoLabel}`,
    toolName: 'browser_launch',
    toolArgs: args,
    riskLevel: 'safe',
  })

  try {
    const session = await createBridgeSession(ptyId, browserArg)
    const browserName = attachTargetLabel(session.browserTarget)
    let output = options.auto
      ? `已自动连接到 ${browserName}（attach 模式，复用当前登录态与标签页）`
      : `已连接到 ${browserName}（attach 模式，复用当前登录态与标签页）`
    const tabs = await bridgeListTabs(ptyId)
    const activeTab = tabs.find((t) => t.active)
    if (activeTab) {
      output += `\n当前标签：${activeTab.title || '(无标题)'} — ${activeTab.url}`
    }
    if (url) {
      const nav = await bridgeTabsNavigate(ptyId, { url, newTab: true })
      output += `\n已在新标签页打开 ${nav.url || url}\n标题: ${nav.title || ''}`
    }
    output += '\n\n💡 使用 browser_snapshot 获取页面元素和 ref 编号'
    output += '\n💡 读文章用 browser_read_article；读整页/区域用 browser_read_page'
    executor.addStep({ type: 'tool_result', content: '已连接浏览器', toolName: 'browser_launch' })
    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '连接浏览器失败'
    executor.addStep({ type: 'tool_result', content: `错误: ${errorMsg}`, toolName: 'browser_launch' })
    return {
      success: false,
      output: '',
      error: `${errorMsg}\n请在 SailFish 设置 → 集成 → 浏览器助手中安装组件并加载扩展。`,
    }
  }
}

export async function bridgeBrowserSnapshot(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig,
): Promise<ToolResult> {
  executor.addStep({
    type: 'tool_call',
    content: '获取页面快照（attach）',
    toolName: 'browser_snapshot',
    toolArgs: args,
    riskLevel: 'safe',
  })
  try {
    const session = getBridgeSession(ptyId)
    if (!session) throw new Error('浏览器未连接。请先 browser_launch attach 模式。')
    const data = (await bridgeSend(ptyId, 'snapshot', {
      interactive: args.interactive !== false,
      maxDepth: args.max_depth,
    })) as BrowserBridgeSnapshotResult
    session.refs = data.refs || {}
    touchBridgeSession(ptyId)
    const tabs = await bridgeListTabs(ptyId)
    const tabsHint = tabs.length > 1 ? `\n(当前窗口 ${tabs.length} 个标签页)` : ''
    const output = formatSnapshotOutput(data, tabsHint)
    executor.addStep({ type: 'tool_result', content: '快照已获取', toolName: 'browser_snapshot' })
    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '获取快照失败'
    executor.addStep({ type: 'tool_result', content: `错误: ${errorMsg}`, toolName: 'browser_snapshot' })
    return { success: false, output: '', error: errorMsg }
  }
}

export async function bridgeBrowserGoto(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig,
): Promise<ToolResult> {
  const url = args.url as string
  if (!url) return { success: false, output: '', error: '缺少 url 参数' }
  // attach 默认新开标签页，避免覆盖用户正在浏览的页面；显式 new_tab: false 才在当前标签导航
  const newTab = args.new_tab !== false
  executor.addStep({
    type: 'tool_call',
    content: newTab ? `在新标签页打开 ${url}` : `导航到 ${url}`,
    toolName: 'browser_goto',
    toolArgs: args,
    riskLevel: 'safe',
  })
  try {
    const session = getBridgeSession(ptyId)
    if (!session) throw new Error('浏览器未连接')
    session.refs = {}
    const tabsBefore = newTab ? await bridgeTabsQuery(ptyId) : []
    const nav = await bridgeTabsNavigate(ptyId, { url, newTab })
    if (newTab) {
      const tabsAfter = await bridgeTabsQuery(ptyId)
      const overwriteError = detectGotoTabOverwrite(tabsBefore, tabsAfter, url, nav, newTab)
      if (overwriteError) {
        executor.addStep({ type: 'tool_result', content: `错误: ${overwriteError}`, toolName: 'browser_goto' })
        return { success: false, output: '', error: overwriteError }
      }
    }
    touchBridgeSession(ptyId)
    const openLabel = nav.new_tab === true ? '已在新标签页打开' : '已导航到'
    let output = `${openLabel} ${nav.url || url}\n标题: ${nav.title || ''}`
    const snap = await bridgeBrowserSnapshot(ptyId, { interactive: true }, executor)
    if (snap.success && snap.output) {
      output += `\n\n--- 当前页面无障碍树快照 ---\n${snap.output}`
    }
    executor.addStep({ type: 'tool_result', content: `已导航到 ${nav.title || url}`, toolName: 'browser_goto' })
    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '导航失败'
    return { success: false, output: '', error: errorMsg }
  }
}

export async function bridgeBrowserClick(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig,
): Promise<ToolResult> {
  const selector = args.selector as string
  if (!selector) return { success: false, output: '', error: '缺少 selector 参数' }
  const session = getBridgeSession(ptyId)
  const clickLabel = selectorToHumanLabel(selector, session?.refs)
  executor.addStep({
    type: 'tool_call',
    content: `点击 ${clickLabel}`,
    toolName: 'browser_click',
    toolArgs: args,
    riskLevel: 'moderate',
  })
  try {
    if (!session) throw new Error('浏览器未连接')
    const payload = selector.startsWith('@')
      ? resolveBridgeRef(session, selector)
      : { selector }
    await bridgeSend(ptyId, 'click', payload)
    touchBridgeSession(ptyId)
    executor.addStep({ type: 'tool_result', content: `已点击 ${clickLabel}`, toolName: 'browser_click' })
    return { success: true, output: `已点击 ${clickLabel}` }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '点击失败'
    return { success: false, output: '', error: errorMsg }
  }
}

export async function bridgeBrowserType(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig,
): Promise<ToolResult> {
  const selector = args.selector as string
  const text = args.text as string
  if (!selector || text === undefined) return { success: false, output: '', error: '缺少 selector 或 text' }
  const session = getBridgeSession(ptyId)
  const typeLabel = selectorToHumanLabel(selector, session?.refs)
  executor.addStep({
    type: 'tool_call',
    content: `在 ${typeLabel} 输入文本`,
    toolName: 'browser_type',
    toolArgs: args,
    riskLevel: 'moderate',
  })
  try {
    if (!session) throw new Error('浏览器未连接')
    const base = selector.startsWith('@') ? resolveBridgeRef(session, selector) : { selector }
    await bridgeSend(ptyId, 'type', {
      ...base,
      text,
      clear: args.clear_first !== false,
    })
    touchBridgeSession(ptyId)
    const result = `已在 ${typeLabel} 输入文本`
    executor.addStep({ type: 'tool_result', content: result, toolName: 'browser_type' })
    return { success: true, output: result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '输入失败'
    return { success: false, output: '', error: errorMsg }
  }
}

export async function bridgeBrowserListTabs(
  ptyId: string,
  executor: ToolExecutorConfig,
): Promise<ToolResult> {
  executor.addStep({
    type: 'tool_call',
    content: '列出标签页',
    toolName: 'browser_list_tabs',
    toolArgs: {},
    riskLevel: 'safe',
  })
  try {
    const tabs = await bridgeListTabs(ptyId)
    const lines = tabs.map(
      (t, i) => `[${i}]${t.active ? ' *' : ''} ${t.title || '(无标题)'} — ${t.url}`,
    )
    return { success: true, output: lines.join('\n') || '(无标签页)' }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '获取标签页失败'
    return { success: false, output: '', error: errorMsg }
  }
}

export async function bridgeBrowserSwitchTab(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig,
): Promise<ToolResult> {
  const index = args.index as number
  if (index === undefined) return { success: false, output: '', error: '缺少 index 参数' }
  executor.addStep({
    type: 'tool_call',
    content: `切换到标签页 ${index}`,
    toolName: 'browser_switch_tab',
    toolArgs: args,
    riskLevel: 'safe',
  })
  try {
    const session = getBridgeSession(ptyId)
    if (!session) throw new Error('浏览器未连接')
    const tab = await bridgeTabsActivate(ptyId, index)
    session.activeTabIndex = index
    session.refs = {}
    touchBridgeSession(ptyId)
    return {
      success: true,
      output: `已切换到标签页 ${index}: ${tab.title || ''}\n${tab.url || ''}`,
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '切换标签页失败'
    return { success: false, output: '', error: errorMsg }
  }
}

export async function bridgeBrowserScroll(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig,
): Promise<ToolResult> {
  const direction = (args.direction as string) || 'down'
  const distance = (args.distance as number) || 500
  let y = distance
  if (direction === 'up') y = -distance
  if (direction === 'top') y = -999999
  if (direction === 'bottom') y = 999999
  try {
    await bridgeSend(ptyId, 'scroll', { y })
    return { success: true, output: `已滚动 ${direction}` }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '滚动失败'
    return { success: false, output: '', error: errorMsg }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function htmlToSimpleMarkdown(html: string): string {
  return html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n')
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

type ContentPayload = {
  content?: string
  html?: string
  fallbackText?: string
  title?: string
  url?: string
}

function formatContentHeader(title: string, pageUrl: string, extra?: string): string {
  return [
    title ? `标题: ${title}` : '',
    pageUrl ? `URL: ${pageUrl}` : '',
    extra || '',
  ].filter(Boolean).join('\n')
}

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content
  return `${content.substring(0, maxLength)}\n\n... (内容过长，已截断，共 ${content.length} 字符)`
}

/** 扩展回传 page_html；旧版无 html 字段时降级为整页 HTML */
async function fetchPageHtmlFromExtension(ptyId: string): Promise<ContentPayload> {
  const data = (await bridgeSend(ptyId, 'get_content', { mode: 'page_html' })) as ContentPayload
  if (data.html) return data

  const legacy = (await bridgeSend(ptyId, 'get_content', { mode: 'html' })) as ContentPayload
  return {
    title: legacy.title || data.title,
    url: legacy.url || data.url,
    html: legacy.content || '',
    fallbackText: data.content || '',
  }
}

/** 智能提取文章正文（Readability 类算法，桌面端） */
export async function bridgeBrowserReadArticle(
  ptyId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const format = (args.format as 'text' | 'html' | 'markdown') || 'text'
  const selector = typeof args.selector === 'string' ? args.selector : undefined
  const maxLength = typeof args.max_length === 'number' ? args.max_length : 16000

  try {
    let title = ''
    let pageUrl = ''
    let content = ''

    if (selector) {
      const data = (await bridgeSend(ptyId, 'get_content', {
        mode: format === 'html' ? 'html' : 'text',
        selector,
      })) as ContentPayload
      title = data.title || ''
      pageUrl = data.url || ''
      content = data.content || ''
    } else {
      const data = await fetchPageHtmlFromExtension(ptyId)
      title = data.title || ''
      pageUrl = data.url || ''
      const html = data.html || ''
      const plainFallback = data.fallbackText || data.content || ''
      const extracted = html
        ? await extractPageContentFromHtml(html, pageUrl || 'https://local.invalid/', plainFallback)
        : { title: null, text: plainFallback, html: null }
      title = extracted.title || title
      if (format === 'markdown' && extracted.html) {
        content = htmlToSimpleMarkdown(extracted.html)
      } else if (format === 'html' && extracted.html) {
        content = extracted.html
      } else {
        content = extracted.text
      }
    }

    if (format === 'markdown' && selector && content) {
      content = htmlToSimpleMarkdown(content)
    }

    content = truncateContent(content, maxLength)
    const header = formatContentHeader(title, pageUrl)
    return {
      success: true,
      output: header ? `${header}\n\n${content}` : content,
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '读取文章失败'
    return { success: false, output: '', error: errorMsg }
  }
}

/** @deprecated 使用 browser_read_article */
export async function bridgeBrowserGetContent(
  ptyId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const extract = (args.extract as string) || 'auto'
  if (extract === 'full') {
    return bridgeBrowserReadPage(ptyId, {
      ...args,
      format: args.format === 'html' ? 'html' : 'text',
    })
  }
  return bridgeBrowserReadArticle(ptyId, args)
}

/** 读取页面上已渲染内容（可见文本或 HTML 源码），不做正文智能过滤 */
export async function bridgeBrowserReadPage(
  ptyId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const format = args.format === 'html' ? 'html' : 'text'
  const selector = typeof args.selector === 'string' ? args.selector : undefined
  const scrollSteps = typeof args.scroll_steps === 'number' ? Math.max(0, Math.min(args.scroll_steps, 20)) : 0
  const scrollDelayMs = typeof args.scroll_delay_ms === 'number' ? args.scroll_delay_ms : 500
  const maxLength = typeof args.max_length === 'number' ? args.max_length : 32000

  try {
    for (let i = 0; i < scrollSteps; i++) {
      await bridgeSend(ptyId, 'scroll', { y: 800 })
      if (scrollDelayMs > 0) await delay(scrollDelayMs)
    }

    const payload: Record<string, unknown> = { mode: format }
    if (selector) payload.selector = selector

    const data = (await bridgeSend(ptyId, 'get_content', payload)) as ContentPayload
    let content = data.content || ''
    const title = data.title || ''
    const pageUrl = data.url || ''

    content = truncateContent(content, maxLength)
    const rangeLabel = selector
      ? `区域: ${selector}`
      : format === 'html'
        ? '范围: 整页 HTML 源码'
        : '范围: 整页可见文本'
    const header = formatContentHeader(title, pageUrl, rangeLabel)

    return {
      success: true,
      output: header ? `${header}\n\n${content}` : content,
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '读取页面失败'
    return { success: false, output: '', error: errorMsg }
  }
}

export async function bridgeBrowserEvaluate(
  ptyId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const script = args.script as string
  if (!script) return { success: false, output: '', error: '缺少 script 参数' }
  try {
    touchBridgeSession(ptyId)
    const data = (await bridgeSend(ptyId, 'evaluate', { expression: script })) as { result?: unknown } | undefined
    if (data == null || typeof data !== 'object') {
      return {
        success: false,
        output: '',
        error: '脚本执行未返回结果（页面可能限制脚本注入，或当前标签不可操作）',
      }
    }
    const result = 'result' in data ? data.result : data
    const output = result !== undefined ? JSON.stringify(result, null, 2) : '(无返回值)'
    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '执行脚本失败'
    return { success: false, output: '', error: errorMsg }
  }
}

export async function bridgeBrowserWait(
  _ptyId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const delay = args.delay as number | undefined
  if (!delay) return { success: false, output: '', error: 'attach 模式暂仅支持 delay 等待' }
  await new Promise((r) => setTimeout(r, delay))
  return { success: true, output: `已等待 ${delay}ms` }
}

export async function bridgeBrowserClose(ptyId: string): Promise<ToolResult> {
  closeBridgeSession(ptyId)
  return { success: true, output: '已断开浏览器连接（您的浏览器窗口保持打开）' }
}

export function isAttachLaunch(args: Record<string, unknown>): boolean {
  return args.attach === true || args.mode === 'attach'
}

/** 显式要求 Playwright 独立窗口（attach: false 或 mode: launch） */
export function wantsExplicitLaunch(args: Record<string, unknown>): boolean {
  return args.attach === false || args.mode === 'launch'
}

/** headless / profile 仅 launch 模式支持 */
export function requiresPlaywrightLaunch(args: Record<string, unknown>): boolean {
  return args.headless === true || (typeof args.profile === 'string' && args.profile.length > 0)
}

export function isBrowserBridgeConnected(): boolean {
  try {
    const status = getBrowserBridgeService().getStatus()
    return status.gatewayRunning && status.connections.length > 0
  } catch {
    return false
  }
}

/** 浏览器助手已连接时优先 attach；显式 launch 或需要 headless/profile 时除外 */
export function shouldPreferAttach(
  args: Record<string, unknown>,
  bridgeConnected = isBrowserBridgeConnected(),
): boolean {
  if (isAttachLaunch(args)) return true
  if (wantsExplicitLaunch(args)) return false
  if (requiresPlaywrightLaunch(args)) return false
  return bridgeConnected
}

export async function ensureBridgeSessionIfPreferred(
  ptyId: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  if (getBridgeSession(ptyId)) return true
  if (!shouldPreferAttach(args)) return false
  try {
    await createBridgeSession(ptyId, args.browser)
    return true
  } catch {
    return false
  }
}

export function shouldUseBridge(ptyId: string): boolean {
  return !!getBridgeSession(ptyId)
}
