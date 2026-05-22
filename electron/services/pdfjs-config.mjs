/**
 * pdfjs-dist getDocument 公共配置（主进程 / utilityProcess / CLI 共用）
 *
 * Node + @napi-rs/canvas 环境必须提供 cMapUrl、standardFontDataUrl，
 * 否则 CJK 字符在页面渲染时会显示为方框（tofu）。
 * 参考：https://github.com/mozilla/pdf.js/blob/master/examples/node/pdf2png/pdf2png.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let cachedAssetUrls = null

export function resolvePdfjsAssetUrls() {
  if (cachedAssetUrls) return cachedAssetUrls
  const pkgJson = require.resolve('pdfjs-dist/package.json')
  const root = path.dirname(pkgJson)
  cachedAssetUrls = {
    cMapUrl: pathToFileURL(path.join(root, 'cmaps')).href + '/',
    standardFontDataUrl: pathToFileURL(path.join(root, 'standard_fonts')).href + '/',
  }
  return cachedAssetUrls
}

/**
 * @param {Uint8Array} data PDF 文件内容
 * @param {Record<string, unknown>} [extra] 额外 getDocument 参数
 */
export function buildPdfDocumentInit(data, extra = {}) {
  const assets = resolvePdfjsAssetUrls()
  return {
    data,
    cMapUrl: assets.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: assets.standardFontDataUrl,
    // Node canvas 不支持 @font-face；禁用后走 pdfjs 内置字体加载路径
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    ...extra,
  }
}
