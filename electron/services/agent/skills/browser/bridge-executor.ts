/**
 * Attach 模式工具执行 — 经浏览器扩展操作用户已打开的浏览器
 */

import type { ToolResult } from '../../types'
import type { ToolExecutorConfig } from '../../tool-executor'
import type { BrowserBridgeRefMap, BrowserBridgeSnapshotResult } from '@shared/types/browser-bridge'
import { getBrowserBridgeService } from '../../../browser-bridge/browser-bridge.service'
import {
  bridgeListTabs,
  bridgeSend,
  closeBridgeSession,
  createBridgeSession,
  getBridgeSession,
  resolveBridgeRef,
  touchBridgeSession,
} from './bridge-session'

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
    '（以下是无障碍树，非视觉页面；颜色、图标等纯视觉信息不会出现；必填项标注为 [必填]；attach 模式复用您当前浏览器登录态）'
  return `${snapshotNote}\n页面: ${data.title}\nURL: ${data.url}${tabsHint}\n${statsLine}\n\n${data.tree}`
}

export async function bridgeBrowserLaunch(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig,
  options: { auto?: boolean } = {},
): Promise<ToolResult> {
  const url = args.url as string | undefined
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
    await createBridgeSession(ptyId)
    let output = options.auto
      ? '已自动连接到您的浏览器（attach 模式，复用当前登录态与标签页）'
      : '已连接到您的浏览器（attach 模式，复用当前登录态与标签页）'
    if (url) {
      const nav = (await bridgeSend('goto', { url })) as { title?: string; url?: string }
      output += `\n已打开 ${nav.url || url}\n标题: ${nav.title || ''}`
    }
    output += '\n\n💡 使用 browser_snapshot 获取页面元素和 ref 编号'
    output += '\n💡 使用 browser_list_tabs 查看所有标签页'
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
    const data = (await bridgeSend('snapshot', {
      interactive: args.interactive !== false,
      maxDepth: args.max_depth,
    })) as BrowserBridgeSnapshotResult
    session.refs = data.refs || {}
    touchBridgeSession(ptyId)
    const tabs = await bridgeListTabs()
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
  executor.addStep({
    type: 'tool_call',
    content: `导航到 ${url}`,
    toolName: 'browser_goto',
    toolArgs: args,
    riskLevel: 'safe',
  })
  try {
    const session = getBridgeSession(ptyId)
    if (!session) throw new Error('浏览器未连接')
    session.refs = {}
    const nav = (await bridgeSend('goto', { url })) as { title?: string; url?: string }
    touchBridgeSession(ptyId)
    let output = `已导航到 ${nav.url || url}\n标题: ${nav.title || ''}`
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
  executor.addStep({
    type: 'tool_call',
    content: `点击 ${selector}`,
    toolName: 'browser_click',
    toolArgs: args,
    riskLevel: 'moderate',
  })
  try {
    const session = getBridgeSession(ptyId)
    if (!session) throw new Error('浏览器未连接')
    const payload = selector.startsWith('@')
      ? resolveBridgeRef(session, selector)
      : { selector }
    await bridgeSend('click', payload)
    touchBridgeSession(ptyId)
    executor.addStep({ type: 'tool_result', content: `已点击 ${selector}`, toolName: 'browser_click' })
    return { success: true, output: `已点击 ${selector}` }
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
  executor.addStep({
    type: 'tool_call',
    content: `在 ${selector} 输入文本`,
    toolName: 'browser_type',
    toolArgs: args,
    riskLevel: 'moderate',
  })
  try {
    const session = getBridgeSession(ptyId)
    if (!session) throw new Error('浏览器未连接')
    const base = selector.startsWith('@') ? resolveBridgeRef(session, selector) : { selector }
    await bridgeSend('type', {
      ...base,
      text,
      clear: args.clear_first !== false,
    })
    touchBridgeSession(ptyId)
    return { success: true, output: `已在 ${selector} 输入文本` }
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
    const tabs = await bridgeListTabs()
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
    const tab = (await bridgeSend('switch_tab', { index })) as { title?: string; url?: string }
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
    await bridgeSend('scroll', { y })
    return { success: true, output: `已滚动 ${direction}` }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '滚动失败'
    return { success: false, output: '', error: errorMsg }
  }
}

export async function bridgeBrowserGetContent(
  ptyId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const data = (await bridgeSend('get_content', {
      mode: args.format === 'html' ? 'html' : 'text',
    })) as { content?: string }
    return { success: true, output: data.content || '' }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '获取内容失败'
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
    const data = (await bridgeSend('evaluate', { expression: script })) as { result?: unknown } | undefined
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
    await createBridgeSession(ptyId)
    return true
  } catch {
    return false
  }
}

export function shouldUseBridge(ptyId: string): boolean {
  return !!getBridgeSession(ptyId)
}
