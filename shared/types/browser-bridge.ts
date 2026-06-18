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

/** Chromium 开发版扩展 ID（manifest key，临时加载 / 解压安装） */
export const BROWSER_BRIDGE_CHROMIUM_DEV_EXTENSION_ID = 'ocdljfppijcjpgaaamgeailkgajgjdml' as const

/** Chromium Chrome Web Store 正式版扩展 ID */
export const BROWSER_BRIDGE_CHROMIUM_CWS_EXTENSION_ID = 'dgmhdapfpihhkboikpgfanpgnijbpdhd' as const

/** Native Host allowed_origins 须同时包含开发与商店 ID */
export const BROWSER_BRIDGE_CHROMIUM_EXTENSION_IDS = [
  BROWSER_BRIDGE_CHROMIUM_DEV_EXTENSION_ID,
  BROWSER_BRIDGE_CHROMIUM_CWS_EXTENSION_ID,
] as const

/** 设置页/故障排查展示的 Chromium 扩展 ID（商店正式版） */
export const BROWSER_BRIDGE_CHROMIUM_EXTENSION_ID = BROWSER_BRIDGE_CHROMIUM_CWS_EXTENSION_ID

/** Chrome Web Store 列表页（设置页「从商店安装」按钮，审核通过后可访问） */
export const BROWSER_BRIDGE_CHROMIUM_CWS_LISTING_URL =
  `https://chromewebstore.google.com/detail/${BROWSER_BRIDGE_CHROMIUM_CWS_EXTENSION_ID}` as const

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
    chromiumDev: string
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
