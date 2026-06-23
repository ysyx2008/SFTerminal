/**
 * HTML 产出物 iframe 预览辅助（纯函数）
 *
 * sandbox iframe 中外部 @import 常被 CSP 拦截并拖垮同块后续 CSS，导致页面只剩深色底。
 */

/** 去掉 sandbox iframe 中易失效的外部 @import，保留同 <style> 内联规则 */
export function stripSandboxBlockedCssImports(html: string): string {
  return html.replace(/@import\s+url\([^)]+\)\s*;?/gi, '')
}

export function htmlPreviewNeedsCssImportStrip(html: string): boolean {
  return /@import\s+url\(/i.test(html)
}

export function normalizeHtmlPreviewContent(html: string, isPptPreview: boolean): string {
  const base = html.trim()
  if (!base) return ''
  if (isPptPreview) return base
  const stripped = htmlPreviewNeedsCssImportStrip(base) ? stripSandboxBlockedCssImports(base) : base
  return stripped.trim()
}
