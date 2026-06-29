/**
 * pdfjs-dist getDocument 公共配置（主进程 / utilityProcess / CLI 共用）
 *
 * Node + @napi-rs/canvas 环境必须提供 cMapUrl、standardFontDataUrl，
 * 否则 CJK 字符在页面渲染时会显示为方框（tofu）。
 * 参考：https://github.com/mozilla/pdf.js/blob/master/examples/node/pdf2png/pdf2png.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
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
 * 把 file:// URL 转回真实文件系统路径；非 file:// 原样返回。
 *
 * 背景：pdfjs-dist 5.x 在 Node 下的 NodeCMapReaderFactory / NodeStandardFontDataFactory
 * 内部用 `fs.promises.readFile(url)` 加载资源，但直接把 file:// URL 当路径喂给 fs.readFile
 * ——Node 的 fs.readFile 不接受 file: 协议 URL，会报 ENOENT（把整个 URL 当成文件名）。
 * 后果：任何需要外部 CMap（如 GBK-EUC-H / GBK2K-H / GB-EUC-H 等）的 PDF 在 Node 下
 * 文本提取会丢字、页面渲染会空白（字体加载失败 + disableFontFace）。
 *
 * 修复方式：注入自定义 factory，先 fileURLToPath 再 readFile。
 * 不改 pdfjs 源码、不依赖其内部基类导出（5.x 不导出 BaseCMapReaderFactory）。
 */
function toFsPath(url) {
  try {
    return fileURLToPath(url)
  } catch {
    return url
  }
}

async function readFileBytes(url) {
  const data = await fs.promises.readFile(toFsPath(url))
  return new Uint8Array(data)
}

/**
 * duck-typed CMapReaderFactory：实现 pdfjs 期望的 `fetch({name})` 接口。
 * 返回 { cMapData: Uint8Array, isCompressed } 与官方契约一致。
 */
export class NodeFileCMapReaderFactory {
  constructor({ baseUrl = null, isCompressed = true } = {}) {
    this.baseUrl = baseUrl
    this.isCompressed = isCompressed
  }
  async fetch({ name }) {
    if (!this.baseUrl) {
      throw new Error('Ensure that the `cMapUrl` and `cMapPacked` API parameters are provided.')
    }
    if (!name) {
      throw new Error('CMap name must be specified.')
    }
    const url = this.baseUrl + name + (this.isCompressed ? '.bcmap' : '')
    try {
      const cMapData = await readFileBytes(url)
      return { cMapData, isCompressed: this.isCompressed }
    } catch (reason) {
      throw new Error(`Unable to load ${this.isCompressed ? 'binary ' : ''}CMap at: ${url}`)
    }
  }
}

/**
 * duck-typed StandardFontDataFactory：实现 pdfjs 期望的 `fetch({name})` 接口。
 * 返回 Uint8Array（与官方 NodeStandardFontDataFactory 一致）。
 */
export class NodeFileStandardFontDataFactory {
  constructor({ baseUrl = null } = {}) {
    this.baseUrl = baseUrl
  }
  async fetch({ name }) {
    if (!this.baseUrl) {
      throw new Error('Ensure that the `standardFontDataUrl` API parameter is provided.')
    }
    const url = this.baseUrl + name
    return readFileBytes(url)
  }
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
    // 注入自定义 factory：绕开 pdfjs 5.x 在 Node 下 fs.readFile(file://URL) 的 bug，
    // 否则需要外部 CMap 的 PDF（GBK-EUC-H 等 CJK 编码）会丢字 / 渲染空白。
    CMapReaderFactory: NodeFileCMapReaderFactory,
    StandardFontDataFactory: NodeFileStandardFontDataFactory,
    // Node canvas 不支持 @font-face；禁用后走 pdfjs 内置字体加载路径
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    ...extra,
  }
}
