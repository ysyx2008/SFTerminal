import type { BrowserBridgeTabInfo } from '@shared/types/browser-bridge'

export interface GotoNavResult {
  title?: string
  url?: string
  new_tab?: boolean
}

/** 检测 attach goto 是否意外覆盖了用户原活动标签（扩展过旧或未重载时常见） */
export function detectGotoTabOverwrite(
  tabsBefore: BrowserBridgeTabInfo[],
  tabsAfter: BrowserBridgeTabInfo[],
  targetUrl: string,
  nav: GotoNavResult,
  requestedNewTab: boolean,
): string | null {
  if (!requestedNewTab) return null
  if (nav.new_tab === true) return null

  const prevActive = tabsBefore.find((t) => t.active)
  if (!prevActive) return null

  const prevAfter = prevActive.id != null ? tabsAfter.find((t) => t.id === prevActive.id) : undefined
  if (prevAfter && prevAfter.url !== prevActive.url) {
    return (
      `浏览器扩展未在新标签页打开链接，已覆盖您原来的标签页（${prevActive.url} → ${prevAfter.url}）。` +
      '请打开 设置 → 集成 → 浏览器助手，点击「重新安装」，然后在 Firefox about:debugging 中对 SailFish 扩展点「重新载入」' +
      '（若从 AMO 商店安装，请改用设置页提供的临时加载路径安装最新版）。'
    )
  }

  const tabCountIncreased = tabsAfter.length > tabsBefore.length
  const afterActive = tabsAfter.find((t) => t.active)
  if (!tabCountIncreased && afterActive?.id === prevActive.id && nav.url?.includes(normalizeHost(targetUrl))) {
    return (
      '当前浏览器扩展版本过旧或未重载，不支持新开标签页（goto 仍在当前标签导航）。' +
      '请在 about:debugging 重新载入 SailFish 浏览器助手扩展后重试。'
    )
  }

  return null
}

function normalizeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
