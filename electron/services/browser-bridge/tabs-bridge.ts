/**
 * 桌面端 Tab 原语 — 优先走扩展 `tabs` action，旧扩展降级 legacy action
 */

import type { BrowserBridgeTabInfo } from '@shared/types/browser-bridge'
import { bridgeSend, getBridgeSession } from '../agent/skills/browser/bridge-session'
import { extensionSupportsTabsManage } from './protocol'
import { getBrowserBridgeService } from './browser-bridge.service'

export type BrowserBridgeTabsOp = 'query' | 'create' | 'update' | 'activate' | 'remove'

export interface GotoNavResult {
  title?: string
  url?: string
  new_tab?: boolean
}

function sessionSupportsTabs(ptyId: string): boolean {
  const session = getBridgeSession(ptyId)
  if (!session) return false
  // 优先读 service 的实时能力（extension reload 后 probeHost 会更新），
  // 避免 BridgeSession.extensionPing 在 install 后长期过期
  const live = getBrowserBridgeService().getConnectionCapabilities(session.origin)
  return extensionSupportsTabsManage(live ?? session.extensionPing)
}

export async function bridgeTabsQuery(
  ptyId: string,
  query: Record<string, unknown> = { currentWindow: true },
): Promise<BrowserBridgeTabInfo[]> {
  if (sessionSupportsTabs(ptyId)) {
    return (await bridgeSend(ptyId, 'tabs', { op: 'query', query })) as BrowserBridgeTabInfo[]
  }
  return (await bridgeSend(ptyId, 'list_tabs', {})) as BrowserBridgeTabInfo[]
}

export async function bridgeTabsCreate(
  ptyId: string,
  options: { url: string; active?: boolean; wait?: boolean },
): Promise<GotoNavResult> {
  if (sessionSupportsTabs(ptyId)) {
    const r = (await bridgeSend(ptyId, 'tabs', {
      op: 'create',
      url: options.url,
      active: options.active !== false,
      wait: options.wait !== false,
    })) as GotoNavResult
    return { ...r, new_tab: true }
  }
  const r = (await bridgeSend(ptyId, 'goto', { url: options.url, new_tab: true })) as GotoNavResult
  return { ...r, new_tab: true }
}

export async function bridgeTabsNavigate(
  ptyId: string,
  options: { url: string; newTab: boolean },
): Promise<GotoNavResult> {
  if (options.newTab) {
    return bridgeTabsCreate(ptyId, { url: options.url, active: true, wait: true })
  }
  if (sessionSupportsTabs(ptyId)) {
    const r = (await bridgeSend(ptyId, 'tabs', {
      op: 'update',
      url: options.url,
      wait: true,
    })) as GotoNavResult
    return { ...r, new_tab: false }
  }
  return (await bridgeSend(ptyId, 'goto', { url: options.url, new_tab: false })) as GotoNavResult
}

export async function bridgeTabsActivate(
  ptyId: string,
  index: number,
): Promise<{ index: number; id?: number; url: string; title: string }> {
  if (sessionSupportsTabs(ptyId)) {
    return (await bridgeSend(ptyId, 'tabs', { op: 'activate', index })) as {
      index: number
      id?: number
      url: string
      title: string
    }
  }
  return (await bridgeSend(ptyId, 'switch_tab', { index })) as {
    index: number
    id?: number
    url: string
    title: string
  }
}

/**
 * 关闭标签页。
 * - 省略 index 时关闭当前激活标签（与 legacy `close_tab` 行为一致）
 * - 给定 index 时走 `tabs.remove`（仅 1.2.0+ 扩展支持）；旧扩展只能关激活 tab
 */
export async function bridgeTabsRemove(
  ptyId: string,
  options: { index?: number } = {},
): Promise<void> {
  if (sessionSupportsTabs(ptyId)) {
    const payload: Record<string, unknown> = { op: 'remove' }
    if (options.index !== undefined) payload.index = options.index
    await bridgeSend(ptyId, 'tabs', payload)
    return
  }
  if (options.index !== undefined) {
    throw new Error(
      '当前浏览器扩展版本过低，不支持按索引关闭标签页；请先 browser_switch_tab 切换到目标标签后再关闭，或升级扩展到 1.2.0+',
    )
  }
  await bridgeSend(ptyId, 'close_tab', {})
}
