/** SailFish 浏览器助手（扩展 + Native Host）共享类型 */

export const BROWSER_BRIDGE_NATIVE_HOST = 'com.sailfish.browser' as const

/** 扩展 ↔ 桌面端协议版本（业务逻辑迭代在桌面端，扩展尽量 frozen） */
export const BROWSER_BRIDGE_PROTOCOL_VERSION = 1 as const

/** 冻结的 action 名单 — 新能力优先扩展 payload，而非新增 action */
export const BROWSER_BRIDGE_ACTIONS = [
  'ping',
  'list_tabs',
  'switch_tab',
  'goto',
  'close_tab',
  'evaluate',
  'snapshot',
  'get_content',
  'click',
  'type',
  'scroll',
] as const

export type BrowserBridgeAction = (typeof BROWSER_BRIDGE_ACTIONS)[number]

/** Chromium 系固定扩展 ID（由 manifest key 推导） */
export const BROWSER_BRIDGE_CHROMIUM_EXTENSION_ID = 'ocdljfppijcjpgaaamgeailkgajgjdml' as const

/** Firefox 扩展 ID（manifest gecko.id） */
export const BROWSER_BRIDGE_FIREFOX_EXTENSION_ID = 'sailfish-browser-bridge@yushen.dev' as const

/** Firefox AMO 商店列表页（设置页「从商店安装」按钮） */
export const BROWSER_BRIDGE_FIREFOX_AMO_LISTING_URL =
  'https://addons.mozilla.org/firefox/addon/sailfish-browser-assistant/' as const

export type BrowserBridgeBrowser = 'chrome' | 'edge' | 'firefox' | 'unknown'

/** attach 路由目标：Chromium 系（Chrome/Edge/Arc 等）与 Firefox 两路 */
export type BrowserBridgeAttachTarget = 'firefox' | 'chromium'

/** browser_launch 的 browser 参数（chrome/edge 归并为 chromium） */
export type BrowserBridgeAttachTargetInput =
  | BrowserBridgeAttachTarget
  | 'auto'
  | 'chrome'
  | 'edge'

export type BrowserBridgeConnectionState = 'disconnected' | 'connected' | 'ready'

export interface BrowserBridgeTabInfo {
  index: number
  id?: number
  url: string
  title: string
  active: boolean
}

export interface BrowserBridgeRefInfo {
  selector: string
  role: string
  name?: string
  nth?: number
  required?: boolean
}

export type BrowserBridgeRefMap = Record<string, BrowserBridgeRefInfo>

export interface BrowserBridgeSnapshotResult {
  tree: string
  refs: BrowserBridgeRefMap
  title: string
  url: string
}

/** 扩展 ↔ Host ↔ Electron 统一命令信封 */
export interface BrowserBridgeCommand {
  id: string
  action: string
  payload?: Record<string, unknown>
}

export interface BrowserBridgeCommandResult {
  id: string
  success: boolean
  data?: unknown
  error?: string
}

/** 扩展 ping 响应 */
export interface BrowserBridgePingResult {
  extension: string
  version: string
  protocol?: number
}

export interface BrowserBridgeInstallStatus {
  chromiumExtensionPath: string
  firefoxExtensionPath: string
  nativeHostManifestPath: string
  registeredBrowsers: BrowserBridgeBrowser[]
  errors: string[]
}

export interface BrowserBridgeConnection {
  browser: BrowserBridgeBrowser
  origin: string
  state: BrowserBridgeConnectionState
}

export interface BrowserBridgeStatus {
  gatewayRunning: boolean
  port: number | null
  connections: BrowserBridgeConnection[]
  install: BrowserBridgeInstallStatus | null
  extensionIds: {
    chromium: string
    firefox: string
  }
}

export function isBrowserBridgeComponentsInstalled(
  install: BrowserBridgeInstallStatus | null | undefined,
): boolean {
  if (!install) return false
  return Boolean(install.chromiumExtensionPath) && install.registeredBrowsers.length > 0
}

export function isChromiumBridgeConnection(conn: BrowserBridgeConnection): boolean {
  return (
    conn.browser === 'chrome'
    || conn.browser === 'edge'
    || conn.origin.startsWith('chrome-extension://')
  )
}

export function isFirefoxBridgeConnection(conn: BrowserBridgeConnection): boolean {
  return (
    conn.browser === 'firefox'
    || conn.origin.startsWith('moz-extension://')
    || (conn.origin.endsWith('.json') && /Mozilla\/NativeMessagingHosts/i.test(conn.origin))
  )
}
