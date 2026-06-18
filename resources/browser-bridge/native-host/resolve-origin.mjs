/**
 * 解析 Native Messaging 启动参数为统一 extension origin
 * - Chromium：chrome-extension://{id}/
 * - Firefox（部分版本）：manifest.json 路径或裸扩展 ID
 */
import fs from 'node:fs'

const DEFAULT_FIREFOX_ORIGIN = 'moz-extension://sailfish-browser-bridge@yushen.dev/'

export function resolveNativeHostOrigin(launchArg) {
  const arg = String(launchArg || '').trim()
  if (!arg) return DEFAULT_FIREFOX_ORIGIN

  if (arg.startsWith('chrome-extension://') || arg.startsWith('moz-extension://')) {
    return arg.endsWith('/') ? arg : `${arg}/`
  }

  if (arg.endsWith('.json')) {
    try {
      const manifest = JSON.parse(fs.readFileSync(arg, 'utf8'))
      const firefoxId = manifest.allowed_extensions?.[0]
      if (firefoxId) return `moz-extension://${firefoxId}/`
      const chromiumOrigin = manifest.allowed_origins?.[0]
      if (typeof chromiumOrigin === 'string' && chromiumOrigin.length > 0) {
        return chromiumOrigin.endsWith('/') ? chromiumOrigin : `${chromiumOrigin}/`
      }
    } catch {
      // fall through
    }
  }

  // Firefox 也可能直接传扩展 ID（如 sailfish-browser-bridge@yushen.dev）
  if (arg.includes('@') || /^[a-z0-9._-]+$/i.test(arg)) {
    return `moz-extension://${arg}/`
  }

  return arg
}
