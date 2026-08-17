/**
 * PDF Worker — runs in Electron utilityProcess to isolate pdfjs-dist
 * from the main process, avoiding a V8/NAPI GC crash (Electron 37).
 *
 * Handles: text extraction, page rendering.
 * In CLI mode this file is NOT used; the service falls back to direct parsing.
 *
 * IMPORTANT: Browser polyfills (DOMMatrix etc.) must be loaded at module scope
 * so they are available both in this thread AND in pdfjs-dist's internal
 * worker_threads (they inherit the process environment but NOT globalThis).
 * We work around this by forcing pdfjs-dist to use its "fake worker" (inline)
 * mode instead of spawning a separate worker_thread.
 */
/* eslint-env node */
/* global globalThis */
'use strict'

const fs = require('fs')
const { pathToFileURL } = require('url')
let _buildPdfDocumentInit = null
async function getBuildPdfDocumentInit() {
  if (!_buildPdfDocumentInit) {
    _buildPdfDocumentInit = (await import('./pdfjs-config.mjs')).buildPdfDocumentInit
  }
  return _buildPdfDocumentInit
}

// Polyfill browser globals needed by pdfjs-dist for coordinate transforms.
// Must be set before pdfjs-dist import so they're available everywhere.
// Adding these makes pdfjs-dist treat the environment as browser-like,
// so we also need a minimal `document` mock for internal canvas creation.
try {
  const canvasModule = require('@napi-rs/canvas')
  for (const name of ['DOMMatrix', 'DOMPoint', 'DOMRect', 'Path2D', 'ImageData']) {
    if (!globalThis[name] && canvasModule[name]) globalThis[name] = canvasModule[name]
  }
  if (!globalThis.document) {
    const { createCanvas } = canvasModule
    globalThis.document = {
      createElement(tag) {
        if (tag === 'canvas') return createCanvas(1, 1)
        return {}
      },
      createElementNS(_ns, tag) {
        if (tag === 'canvas') return createCanvas(1, 1)
        return {}
      },
    }
  }
} catch {
  // @napi-rs/canvas not available
}

let pdfjsLib = null
let napiCanvas = null
let extractPdfText = null
async function getExtractPdfText() {
  if (!extractPdfText) {
    extractPdfText = (await import('./pdf-text-extract.mjs')).extractPdfText
  }
  return extractPdfText
}

async function loadPdfjs() {
  if (!pdfjsLib) {
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
    pdfjsLib = mod

    // Use destructured named export to ensure we set the right object
    const { GlobalWorkerOptions } = mod
    try {
      // pdfjs-dist 通过动态 import() 加载 fake worker，必须传 file:// URL，
      // 否则 Windows 上 'C:\\...\\pdf.worker.mjs' 会被 Node ESM 解析成协议 'c:' 而报错
      const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
      GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href
    } catch {
      // If resolve fails, pdfjs-dist will try its fallback
    }
  }
  return pdfjsLib
}

async function loadCanvas() {
  if (napiCanvas !== null) return napiCanvas || null
  try {
    napiCanvas = await import('@napi-rs/canvas')
    return napiCanvas
  } catch {
    napiCanvas = false
    return null
  }
}

// ────────── Operations ──────────

const PDF_POINTS_PER_INCH = 72
const MAX_RENDER_PAGES = 10
const PROGRESS_PERCENT_STEP = 5

/**
 * 为高频按页进度回调做节流：percent 至少跨 5% 或到达末页才下发，
 * 避免大 PDF 每页都发 IPC 消息（数百次）拖累渲染进程。
 */
function makeThrottledProgress(send) {
  let lastPercent = -PROGRESS_PERCENT_STEP
  return (payload) => {
    const percent = payload?.percent ?? 0
    const isLast = payload?.current && payload?.total && payload.current === payload.total
    if (isLast || percent - lastPercent >= PROGRESS_PERCENT_STEP) {
      lastPercent = percent
      send(payload)
    }
  }
}

async function parsePdf({ filePath, maxTextLength }, sendProgress) {
  const progress = makeThrottledProgress(sendProgress)
  const extract = await getExtractPdfText()
  return extract(filePath, {
    maxTextLength,
    onProgress: (current, total) => {
      progress({
        phase: 'extracting-text',
        current,
        total,
        percent: Math.round((current / Math.max(total, 1)) * 100),
      })
    },
  })
}

async function renderPdfPages({ filePath, pageNumbers, dpi = 200, quality = 85 }, progress) {
  const pdfjs = await loadPdfjs()
  const canvas = await loadCanvas()
  if (!canvas) throw new Error('@napi-rs/canvas not available in PDF worker')

  const { createCanvas } = canvas
  const scale = dpi / PDF_POINTS_PER_INCH
  const pagesToRender = pageNumbers.slice(0, MAX_RENDER_PAGES)

  const data = new Uint8Array(fs.readFileSync(filePath))
  const buildPdfDocumentInit = await getBuildPdfDocumentInit()
  const doc = await pdfjs.getDocument(buildPdfDocumentInit(data)).promise
  const totalPages = doc.numPages
  const images = []

  const canvasFactory = {
    create(w, h) {
      const c = createCanvas(w, h)
      return { canvas: c, context: c.getContext('2d') }
    },
    reset(pair, w, h) {
      pair.canvas.width = w
      pair.canvas.height = h
    },
    destroy(pair) {
      pair.canvas.width = 0
      pair.canvas.height = 0
    },
  }

  try {
    for (let index = 0; index < pagesToRender.length; index++) {
      const pageNum = pagesToRender[index]
      if (pageNum < 1 || pageNum > totalPages) continue
      const page = await doc.getPage(pageNum)
      const viewport = page.getViewport({ scale })
      const w = Math.floor(viewport.width)
      const h = Math.floor(viewport.height)
      const c = createCanvas(w, h)
      const ctx = c.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      await page.render({ canvasContext: ctx, viewport, canvasFactory }).promise
      const buf = c.toBuffer('image/jpeg', quality)
      images.push(`data:image/jpeg;base64,${buf.toString('base64')}`)
      progress({
        phase: 'rendering-preview',
        current: index + 1,
        total: pagesToRender.length,
        percent: Math.round(((index + 1) / Math.max(pagesToRender.length, 1)) * 100),
      })
    }
  } finally {
    doc.destroy()
  }

  return { images, totalPages }
}

// ────────── IPC ──────────

function send(id, success, result, error) {
  process.parentPort.postMessage({ id, success, result, error })
}

function sendProgress(id, progress) {
  process.parentPort.postMessage({ id, type: 'progress', progress })
}

process.parentPort.on('message', async (e) => {
  const { type, data, id } = e.data
  try {
    let result
    const progress = (payload) => sendProgress(id, payload)
    switch (type) {
      case 'parsePdf':
        result = await parsePdf(data, progress)
        break
      case 'renderPdfPages':
        result = await renderPdfPages(data, progress)
        break
      default:
        send(id, false, undefined, `Unknown type: ${type}`)
        return
    }
    send(id, true, result, undefined)
  } catch (err) {
    send(id, false, undefined, err && err.message ? err.message : String(err))
  }
})
