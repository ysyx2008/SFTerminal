/**
 * 桌面端 Tab 原语 — 优先走扩展 `tabs` action，旧扩展降级 legacy action
 */

import type { BrowserBridgeTabInfo } from '@shared/types/browser-bridge'
import { bridgeSend, getBridgeSession } from '../agent/skills/browser/bridge-session'
import { extensionSupportsTabsManage } from './protocol'

export type BrowserBridgeTabsOp = 'query' | 'create' | 'update' | 'activate' | 'remove'

export interface GotoNavResult {
  title?: string
  url?: string
  new_tab?: boolean
}

function sessionSupportsTabs(ptyId: string): boolean {
  const session = getBridgeSession(ptyId)
  return extensionSupportsTabsManage(session?.extensionPing)
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

export async function bridgeTabsRemoveActive(ptyId: string): Promise<void> {
  if (sessionSupportsTabs(ptyId)) {
    await bridgeSend(ptyId, 'tabs', { op: 'remove' })
    return
  }
  await bridgeSend(ptyId, 'close_tab', {})
}
