/**
 * PDF 正文抽取：优先本地结构化 Markdown，失败或不可用时回退 pdfjs 拼字。
 * worker（utilityProcess）与 CLI/无 worker 回退共用，避免两套逻辑分叉。
 */
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { buildPdfDocumentInit } from './pdfjs-config.mjs'

const require = createRequire(import.meta.url)

/** @type {Promise<typeof import('@firecrawl/pdf-inspector') | null> | null} */
let inspectorLoad = null
/** @type {typeof import('pdfjs-dist/legacy/build/pdf.mjs') | null} */
let pdfjsLib = null

function loadInspector() {
  if (!inspectorLoad) {
    inspectorLoad = import('@firecrawl/pdf-inspector').catch(() => null)
  }
  return inspectorLoad
}

async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
  try {
    const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
    mod.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href
  } catch {
    // 解析不到 worker 时走 pdfjs 默认行为
  }
  pdfjsLib = mod
  return mod
}

/**
 * processPdf 标注为 1-indexed；classifyPdf 为 0-indexed。
 * 若出现 0 则按 0-indexed 纠正，避免渲错页。
 * @param {unknown} pages
 * @param {number} totalPages
 * @returns {number[]}
 */
export function normalizeOcrPages(pages, totalPages) {
  if (!Array.isArray(pages) || pages.length === 0 || totalPages <= 0) return []
  const nums = pages.filter((n) => Number.isInteger(n))
  if (nums.length === 0) return []
  const zeroBased = nums.includes(0)
  return [...new Set(nums.map((p) => (zeroBased ? p + 1 : p)))]
    .filter((p) => p >= 1 && p <= totalPages)
}

/**
 * @param {string} filePath
 * @param {{ maxTextLength?: number, onProgress?: (current: number, total: number) => void }} [opts]
 */
export async function extractPdfText(filePath, opts = {}) {
  const maxTextLength = opts.maxTextLength ?? Infinity
  const onProgress = opts.onProgress
  const inspector = await loadInspector()
  if (inspector?.processPdfAsync) {
    try {
      const result = await inspector.processPdfAsync(fs.readFileSync(filePath))
      const pdfType = result.pdfType
      let content = typeof result.markdown === 'string' ? result.markdown.trim() : ''
      const totalPages = Number.isInteger(result.pageCount) ? result.pageCount : 0
      const pagesNeedingOcr = normalizeOcrPages(result.pagesNeedingOcr, totalPages)
      const knownType = pdfType === 'TextBased' || pdfType === 'Scanned'
        || pdfType === 'ImageBased' || pdfType === 'Mixed'
      // 宣称有文字层却抽不出正文：编码/解析 miss，改走 pdfjs
      if (!(pdfType === 'TextBased' && !content) && knownType) {
        if (content.length > maxTextLength) content = content.slice(0, maxTextLength)
        onProgress?.(totalPages, Math.max(totalPages, 1))
        return {
          content,
          pageCount: totalPages,
          totalPages,
          pdfType,
          pagesNeedingOcr,
          extractor: 'inspector',
        }
      }
    } catch {
      // 原生包缺失、解析抛错：回退 pdfjs
    }
  }
  return extractPdfTextWithPdfjs(filePath, { maxTextLength, onProgress })
}

/**
 * @param {string} filePath
 * @param {{ maxTextLength?: number, onProgress?: (current: number, total: number) => void }} [opts]
 */
export async function extractPdfTextWithPdfjs(filePath, opts = {}) {
  const maxTextLength = opts.maxTextLength ?? Infinity
  const onProgress = opts.onProgress
  const pdfjs = await loadPdfjs()
  const data = new Uint8Array(fs.readFileSync(filePath))
  const doc = await pdfjs.getDocument(buildPdfDocumentInit(data)).promise
  const totalPages = doc.numPages
  const textParts = []
  let totalChars = 0
  let extractedPages = 0
  try {
    for (let i = 1; i <= totalPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      const pageText = tc.items
        .filter((item) => 'str' in item)
        .map((item) => item.str)
        .join(' ')
        .trim()
      textParts.push(pageText)
      extractedPages = i
      totalChars += pageText.length
      onProgress?.(i, totalPages)
      if (totalChars >= maxTextLength) break
    }
  } finally {
    doc.destroy()
  }
  return {
    content: textParts.join('\n\n').trim(),
    pageCount: extractedPages,
    totalPages,
    pdfType: undefined,
    pagesNeedingOcr: [],
    extractor: 'pdfjs',
  }
}
