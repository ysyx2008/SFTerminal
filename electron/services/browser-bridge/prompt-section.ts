import type { BrowserBridgeStatus } from '@shared/types/browser-bridge'
import {
  isBrowserBridgeComponentsInstalled,
  isChromiumBridgeConnection,
  isFirefoxBridgeConnection,
} from '@shared/types/browser-bridge'

/**
 * 将浏览器助手连接状态格式化为 Agent 系统提示章节。
 * 扩展未安装且未连接时返回空字符串（不占用 token）。
 */
export function buildBrowserBridgePromptSection(status: BrowserBridgeStatus): string {
  const connections = status.connections ?? []
  const chromiumConnected = connections.some(isChromiumBridgeConnection)
  const firefoxConnected = connections.some(isFirefoxBridgeConnection)
  const anyConnected = chromiumConnected || firefoxConnected
  const componentsInstalled = isBrowserBridgeComponentsInstalled(status.install)

  if (!anyConnected && !componentsInstalled) {
    return ''
  }

  const lines: string[] = ['# 浏览器助手']

  if (anyConnected) {
    const statusParts: string[] = []
    if (chromiumConnected) statusParts.push('✅ Chromium（Chrome/Edge 等）已连接')
    else statusParts.push('❌ Chromium 未连接')
    if (firefoxConnected) statusParts.push('✅ Firefox 已连接')
    else statusParts.push('❌ Firefox 未连接')
    lines.push(statusParts.join('\n'))
    lines.push('')
    lines.push('**操控规则**（扩展已在线，优先 attach）：')
    lines.push('- 先 `skill load browser`，然后直接 `browser_goto` / `browser_snapshot` 等，**无需** `browser_launch`')
    lines.push('- 系统会自动 attach 到用户当前浏览器，复用登录态与已有标签页')
    lines.push('- 用户说「打开 XX 网页 / 在浏览器里看」时，不要开 Playwright 独立窗口（除非需要截图/无头）')
    lines.push('- 用户可能已打开目标页：先 `browser_list_tabs`，有则 `browser_switch_tab`，无则 `browser_goto`')
    if (chromiumConnected && firefoxConnected) {
      lines.push('- **两个浏览器都在线**：须指定 `browser: "chromium"` 或 `"firefox"`')
    }
    lines.push('- 需要截图/无头/profile 时才 `browser_launch { "mode": "launch" }`')
  } else {
    lines.push('❌ 扩展未连接（组件已安装，但未检测到在线扩展）')
    lines.push('')
    lines.push('- 若需操作用户浏览器登录态，提示用户在 设置 → 集成 → 浏览器助手 中加载扩展')
    lines.push('- 或无扩展时用 `browser_launch { "mode": "launch" }` 开独立窗口')
  }

  return lines.join('\n')
}
