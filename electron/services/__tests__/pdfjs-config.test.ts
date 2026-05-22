import { describe, it, expect } from 'vitest'
import { buildPdfDocumentInit, resolvePdfjsAssetUrls } from '../pdfjs-config.mjs'

describe('pdfjs-config', () => {
  it('应解析 cMap 与 standard_fonts 的 file:// URL', () => {
    const urls = resolvePdfjsAssetUrls()
    expect(urls.cMapUrl).toMatch(/^file:\/\/.+\/cmaps\/$/)
    expect(urls.standardFontDataUrl).toMatch(/^file:\/\/.+\/standard_fonts\/$/)
  })

  it('buildPdfDocumentInit 应包含 Node 渲染所需字段', () => {
    const data = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    const init = buildPdfDocumentInit(data)
    expect(init.data).toBe(data)
    expect(init.cMapPacked).toBe(true)
    expect(init.disableFontFace).toBe(true)
    expect(init.useSystemFonts).toBe(false)
    expect(init.isEvalSupported).toBe(false)
    expect(init.cMapUrl).toContain('/cmaps/')
    expect(init.standardFontDataUrl).toContain('/standard_fonts/')
  })
})
