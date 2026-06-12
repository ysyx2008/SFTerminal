/** SailFish 浏览器助手（扩展 + Native Host）共享类型 */

export const BROWSER_BRIDGE_NATIVE_HOST = 'com.sailfish.browser' as const

/** Chromium 系固定扩展 ID（由 manifest key 推导） */
export const BROWSER_BRIDGE_CHROMIUM_EXTENSION_ID = 'ocdljfppijcjpgaaamgeailkgajgjdml' as const

/** Firefox 扩展 ID（manifest gecko.id） */
export const BROWSER_BRIDGE_FIREFOX_EXTENSION_ID = 'sailfish-browser-bridge@yushen.dev' as const

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

export interface BrowserBridgeInstallStatus {
  chromiumExtensionPath: string
  firefoxExtensionPath: string
  nativeHostManifestPath: string
  registeredBrowsers: BrowserBridgeBrowser[]
  errors: string[]
}

export interface BrowserBridgeStatus {
  gatewayRunning: boolean
  port: number | null
  connections: Array<{
    browser: BrowserBridgeBrowser
    origin: string
    state: BrowserBridgeConnectionState
  }>
  install: BrowserBridgeInstallStatus | null
  extensionIds: {
    chromium: string
    firefox: string
  }
}
