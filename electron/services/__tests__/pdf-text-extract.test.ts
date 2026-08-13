import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import { extractPdfText, extractPdfTextWithPdfjs, normalizeOcrPages } from '../pdf-text-extract.mjs'

function makeTextPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const stream = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET\n`
  const streamLen = Buffer.byteLength(stream)
  const parts = [
    '%PDF-1.4\n',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n',
    `4 0 obj << /Length ${streamLen} >> stream\n${stream}endstream endobj\n`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n',
  ]
  const offsets: number[] = []
  let cursor = 0
  for (const part of parts) {
    offsets.push(cursor)
    cursor += Buffer.byteLength(part)
  }
  let xref = `xref\n0 6\n0000000000 65535 f \n`
  for (let i = 1; i <= 5; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`
  return Buffer.concat([Buffer.from(parts.join('')), Buffer.from(xref + trailer)])
}

function withTempPdf(text: string): { filePath: string; cleanup: () => void } {
  const filePath = path.join(os.tmpdir(), `pdf-extract-${crypto.randomUUID()}.pdf`)
  fs.writeFileSync(filePath, makeTextPdf(text))
  return { filePath, cleanup: () => { try { fs.unlinkSync(filePath) } catch { /* ignore */ } } }
}

describe('normalizeOcrPages', () => {
  it('1-indexed 页码原样保留', () => {
    expect(normalizeOcrPages([1, 5, 12], 20)).toEqual([1, 5, 12])
  })

  it('出现 0 时按 0-indexed 纠正', () => {
    expect(normalizeOcrPages([0, 4], 10)).toEqual([1, 5])
  })

  it('丢弃越界与非整数', () => {
    expect(normalizeOcrPages([1, 99, 2.5, 'x'], 5)).toEqual([1])
  })

  it('空输入返回空数组', () => {
    expect(normalizeOcrPages(undefined, 5)).toEqual([])
    expect(normalizeOcrPages([], 5)).toEqual([])
  })
})

describe('extractPdfText', () => {
  it('应从文字 PDF 抽出正文', async () => {
    const { filePath, cleanup } = withTempPdf('Hello SailFish')
    try {
      const result = await extractPdfText(filePath, { maxTextLength: 10000 })
      expect(result.totalPages).toBe(1)
      expect(result.content).toMatch(/Hello SailFish/)
      expect(['inspector', 'pdfjs']).toContain(result.extractor)
      if (result.extractor === 'inspector') {
        expect(result.pdfType).toBe('TextBased')
      }
    } finally {
      cleanup()
    }
  })

  it('pdfjs 回退路径也能抽出正文', async () => {
    const { filePath, cleanup } = withTempPdf('Hello SailFish')
    try {
      const result = await extractPdfTextWithPdfjs(filePath, { maxTextLength: 10000 })
      expect(result.extractor).toBe('pdfjs')
      expect(result.content).toMatch(/Hello SailFish/)
    } finally {
      cleanup()
    }
  })
})
