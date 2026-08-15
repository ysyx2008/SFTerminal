import type { BrowserBridgeStatus } from '@shared/types/browser-bridge'
import {
  isBrowserBridgeComponentsInstalled,
  isChromiumBridgeConnection,
  isFirefoxBridgeConnection,
} from '@shared/types/browser-bridge'

/** 系统提示中浏览器助手章节的 Markdown 标题（与 buildBrowserBridgePromptSection 一致） */
export const BROWSER_BRIDGE_PROMPT_HEADING = '# 浏览器助手'

const HOST_ENV_HEADINGS = ['# 主机环境（命令必须匹配）', '# 运行环境'] as const

function findMarkdownSectionBounds(content: string, heading: string): { start: number; end: number } | null {
  const start = content.indexOf(heading)
  if (start === -1) return null
  const rest = content.slice(start + heading.length)
  const nextMatch = rest.match(/\n\n# /)
  const end = nextMatch?.index !== undefined ? start + heading.length + nextMatch.index : content.length
  return { start, end }
}

/**
 * 在已有 system prompt 中替换/插入/移除浏览器助手章节。
 * 用于 prompt cache 复用时刷新连接状态，而不重建整段 system prompt。
 */
export function patchBrowserBridgeSectionInSystemPrompt(
  systemPrompt: string,
  status: BrowserBridgeStatus,
): string {
  const newSection = buildBrowserBridgePromptSection(status)
  const bounds = findMarkdownSectionBounds(systemPrompt, BROWSER_BRIDGE_PROMPT_HEADING)

  if (bounds) {
    if (!newSection) {
      const { start, end } = bounds
      let s = start
      if (s >= 2 && systemPrompt.slice(s - 2, s) === '\n\n') s -= 2
      return systemPrompt.slice(0, s) + systemPrompt.slice(end)
    }
    return systemPrompt.slice(0, bounds.start) + newSection + systemPrompt.slice(bounds.end)
  }

  if (!newSection) return systemPrompt

  for (const hostHeading of HOST_ENV_HEADINGS) {
    const hostBounds = findMarkdownSectionBounds(systemPrompt, hostHeading)
    if (hostBounds) {
      return systemPrompt.slice(0, hostBounds.end) + '\n\n' + newSection + systemPrompt.slice(hostBounds.end)
    }
  }

  return `${newSection}\n\n${systemPrompt}`
}

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

  const lines: string[] = [BROWSER_BRIDGE_PROMPT_HEADING]

  if (anyConnected) {
    const statusParts: string[] = []
    if (chromiumConnected) statusParts.push('✅ Chromium（Chrome/Edge 等）已连接')
    else statusParts.push('❌ Chromium 未连接')
    if (firefoxConnected) statusParts.push('✅ Firefox 已连接')
    else statusParts.push('❌ Firefox 未连接')
    lines.push(statusParts.join('\n'))
    lines.push('')
    lines.push('**两档能力**（助手已在线）：')
    lines.push('- 先 `skill load browser`。未指定 mode 时系统会吸附到用户当前浏览器，可直接 `browser_goto` / `browser_snapshot` 等，**无需**先 launch')
    lines.push('- **吸附**：复用登录态与已开标签；evaluate 仅白名单；无截图、无按元素等待、无 Network/开发者工具。`browser_goto` 默认新开标签，不覆盖当前页')
    lines.push('- **独立窗口**：`browser_launch { "mode": "launch" }`。完整 JS、截图、按元素等待。打开后后续操作留在该窗口')
    lines.push('- 用户可能已打开目标页：`browser_list_tabs` / `browser_switch_tab`')
    if (chromiumConnected && firefoxConnected) {
      lines.push('- **两个浏览器都在线**：须指定 `browser: "chromium"` 或 `"firefox"`')
    }
  } else {
    lines.push('❌ 扩展未连接（组件已安装，但未检测到在线扩展）')
    lines.push('')
    lines.push('- 若需操作用户浏览器登录态，提示用户在 设置 → 集成 → 浏览器助手 中加载扩展')
    lines.push('- 无扩展时用 `browser_launch { "mode": "launch" }` 开独立窗口（完整 JS / 截图；登录态靠 profile）')
  }

  return lines.join('\n')
}
