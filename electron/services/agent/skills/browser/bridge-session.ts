/**
 * Attach 模式会话 — 通过浏览器扩展操作用户已打开的 Chrome/Edge/Firefox
 */

import type {
  BrowserBridgeAttachTarget,
  BrowserBridgeRefMap,
  BrowserBridgeTabInfo,
} from '@shared/types/browser-bridge'
import { getBrowserBridgeService } from '../../../browser-bridge/browser-bridge.service'

export interface BridgeSession {
  mode: 'attach'
  ptyId: string
  browserTarget: BrowserBridgeAttachTarget
  origin: string
  createdAt: number
  lastActivityAt: number
  refs: BrowserBridgeRefMap
  activeTabIndex: number
}

const sessions = new Map<string, BridgeSession>()

export function getBridgeSession(ptyId: string): BridgeSession | undefined {
  return sessions.get(ptyId)
}

export function hasBridgeSession(ptyId: string): boolean {
  return sessions.has(ptyId)
}

export async function createBridgeSession(
  ptyId: string,
  browserInput?: unknown,
): Promise<BridgeSession> {
  const bridge = getBrowserBridgeService()
  const { origin, browserTarget } = bridge.resolveConnection(browserInput)
  await bridge.sendCommand('ping', {}, { origin })
  const session: BridgeSession = {
    mode: 'attach',
    ptyId,
    browserTarget,
    origin,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    refs: {},
    activeTabIndex: 0,
  }
  sessions.set(ptyId, session)
  return session
}

export function closeBridgeSession(ptyId: string): void {
  sessions.delete(ptyId)
}

export function touchBridgeSession(ptyId: string): void {
  const session = sessions.get(ptyId)
  if (session) session.lastActivityAt = Date.now()
}

export async function bridgeListTabs(ptyId: string): Promise<BrowserBridgeTabInfo[]> {
  const tabs = await bridgeSend(ptyId, 'list_tabs', {})
  return tabs as BrowserBridgeTabInfo[]
}

export async function bridgeSend(
  ptyId: string,
  action: string,
  payload: Record<string, unknown> = {},
): Promise<unknown> {
  const session = sessions.get(ptyId)
  if (!session) {
    throw new Error('浏览器未连接。请先 browser_launch attach 模式。')
  }
  return getBrowserBridgeService().sendCommand(action, payload, { origin: session.origin })
}

export function resolveBridgeRef(session: BridgeSession, ref: string): { ref: string } {
  const refId = ref.startsWith('@') ? ref.slice(1) : ref
  if (!session.refs[refId]) {
    const available = Object.keys(session.refs)
    const hint = available.length
      ? `当前可用的 ref: ${available.slice(0, 10).map((r) => '@' + r).join(', ')}`
      : '当前没有可用的 ref，请先调用 browser_snapshot'
    throw new Error(`ref "${refId}" 未找到。${hint}`)
  }
  return { ref: refId }
}

export function closeAllBridgeSessions(): void {
  sessions.clear()
}
