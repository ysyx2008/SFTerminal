import { describe, expect, it } from 'vitest'
import {
  htmlPreviewNeedsCssImportStrip,
  normalizeHtmlPreviewContent,
  stripSandboxBlockedCssImports
} from '../domain/html-preview'

describe('html-preview', () => {
  it('stripSandboxBlockedCssImports 移除 @import 并保留后续规则', () => {
    const input = `<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter');
  body { color: #fff; background: #000; }
</style>`
    const out = stripSandboxBlockedCssImports(input)
    expect(out).not.toMatch(/@import/i)
    expect(out).toContain('body { color: #fff; background: #000; }')
  })

  it('htmlPreviewNeedsCssImportStrip 检测外链 @import', () => {
    expect(htmlPreviewNeedsCssImportStrip("@import url('https://x');")).toBe(true)
    expect(htmlPreviewNeedsCssImportStrip('body{color:red}')).toBe(false)
  })

  it('normalizeHtmlPreviewContent 对普通 HTML 去掉 @import，PPT 预览不处理', () => {
    const html = "@import url('https://x'); h1{color:red}"
    expect(normalizeHtmlPreviewContent(html, false)).toBe('h1{color:red}')
    expect(normalizeHtmlPreviewContent(html, true)).toBe(html)
  })
})
