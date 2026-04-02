/**
 * PDF Worker — runs in Electron utilityProcess to isolate pdfjs-dist
 * from the main process, avoiding a V8/NAPI GC crash (Electron 37).
 *
 * Handles: text extraction, image detection, page rendering.
 * In CLI mode this file is NOT used; the service falls back to direct parsing.
 *
 * IMPORTANT: Browser polyfills (DOMMatrix etc.) must be loaded at module scope
 * so they are available both in this thread AND in pdfjs-dist's internal
 * worker_threads (they inherit the process environment but NOT globalThis).
 * We work around this by forcing pdfjs-dist to use its "fake worker" (inline)
 * mode instead of spawning a separate worker_thread.
 */
/* eslint-env node */
'use strict'

const fs = require('fs')

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
let pdfjsGetDocument = null
let napiCanvas = null

async function loadPdfjs() {
  if (!pdfjsLib) {
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
    pdfjsLib = mod
    pdfjsGetDocument = mod.getDocument

    // Use destructured named export to ensure we set the right object
    const { GlobalWorkerOptions } = mod
    try {
      GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
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

async function parsePdf({ filePath, maxTextLength }) {
  const pdfjs = await loadPdfjs()
  const data = new Uint8Array(fs.readFileSync(filePath))
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise

  const pageCount = doc.numPages
  const textParts = []
  let totalChars = 0
  let extractedPages = 0

  try {
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      const pageText = tc.items
        .filter(item => 'str' in item)
        .map(item => item.str)
        .join(' ')
        .trim()
      textParts.push(pageText)
      extractedPages = i
      totalChars += pageText.length
      if (totalChars >= maxTextLength) break
    }
  } finally {
    doc.destroy()
  }

  return {
    content: textParts.join('\n\n').trim(),
    pageCount: extractedPages,
    totalPages: pageCount,
  }
}

async function pdfHasImages({ filePath, pageCount }) {
  const pdfjs = await loadPdfjs()
  const OPS = pdfjs.OPS
  const IMAGE_OPS = new Set([OPS.paintImageXObject, OPS.paintImageMaskXObject, OPS.paintInlineImageXObject])

  const data = new Uint8Array(fs.readFileSync(filePath))
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise

  try {
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i)
      const ops = await page.getOperatorList()
      for (const fn of ops.fnArray) {
        if (IMAGE_OPS.has(fn)) return true
      }
    }
    return false
  } finally {
    doc.destroy()
  }
}

async function renderPdfPages({ filePath, pageNumbers, dpi = 200, quality = 85 }) {
  const pdfjs = await loadPdfjs()
  const canvas = await loadCanvas()
  if (!canvas) throw new Error('@napi-rs/canvas not available in PDF worker')

  const { createCanvas } = canvas
  const scale = dpi / PDF_POINTS_PER_INCH
  const pagesToRender = pageNumbers.slice(0, MAX_RENDER_PAGES)

  const data = new Uint8Array(fs.readFileSync(filePath))
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise
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
    for (const pageNum of pagesToRender) {
      if (pageNum < 1 || pageNum > totalPages) continue
      const page = await doc.getPage(pageNum)
      const viewport = page.getViewport({ scale })
      const w = Math.floor(viewport.width)
      const h = Math.floor(viewport.height)
      const c = createCanvas(w, h)
      const ctx = c.getContext('2d')
      await page.render({ canvasContext: ctx, viewport, canvasFactory }).promise
      const buf = c.toBuffer('image/jpeg', quality)
      images.push(`data:image/jpeg;base64,${buf.toString('base64')}`)
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

process.parentPort.on('message', async (e) => {
  const { type, data, id } = e.data
  try {
    let result
    switch (type) {
      case 'parsePdf':
        result = await parsePdf(data)
        break
      case 'pdfHasImages':
        result = await pdfHasImages(data)
        break
      case 'renderPdfPages':
        result = await renderPdfPages(data)
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
