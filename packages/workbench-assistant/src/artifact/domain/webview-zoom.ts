/** 网页预览缩放：比例只在当次打开期间有效，重启回到 100%。 */

export const WEBVIEW_ZOOM_DEFAULT = 1
export const WEBVIEW_ZOOM_MIN = 0.5
export const WEBVIEW_ZOOM_MAX = 2
export const WEBVIEW_ZOOM_STEP = 0.1

export function clampWebviewZoom(factor: number): number {
  if (!Number.isFinite(factor)) return WEBVIEW_ZOOM_DEFAULT
  const stepped = Math.round(factor / WEBVIEW_ZOOM_STEP) * WEBVIEW_ZOOM_STEP
  const clamped = Math.min(WEBVIEW_ZOOM_MAX, Math.max(WEBVIEW_ZOOM_MIN, stepped))
  return Number(clamped.toFixed(1))
}

export function stepWebviewZoom(factor: number, direction: 1 | -1): number {
  return clampWebviewZoom(factor + direction * WEBVIEW_ZOOM_STEP)
}

export function formatWebviewZoomPercent(factor: number): string {
  return `${Math.round(clampWebviewZoom(factor) * 100)}%`
}
