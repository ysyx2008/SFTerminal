import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { convertHtmlToPptx } from '../html-to-pptx'
import { parseSlidesFromHtml } from '../html-parse'

const SAMPLE_HTML = `
<section class="slide" data-layout="title" data-theme="midnight" style="width:1600px;height:900px">
  <h1>测试演示</h1>
  <p class="subtitle">Phase 1</p>
</section>
<section class="slide" data-layout="content" style="width:1600px;height:900px">
  <h2>要点</h2>
  <ul>
    <li>第一项</li>
    <li>第二项</li>
  </ul>
</section>
<section class="slide" data-layout="closing" data-theme="midnight" style="width:1600px;height:900px">
  <h1>谢谢</h1>
</section>
`

describe('parseSlidesFromHtml', () => {
  it('parses multiple slides', () => {
    const slides = parseSlidesFromHtml(SAMPLE_HTML)
    expect(slides).toHaveLength(3)
    expect(slides[0].layout).toBe('title')
    expect(slides[1].layout).toBe('content')
  })

  it('throws when no slides', () => {
    expect(() => parseSlidesFromHtml('<p>no slides</p>')).toThrow(/slide/)
  })
})

describe('convertHtmlToPptx', () => {
  const tmpFiles: string[] = []

  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f)
      } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  it('writes a non-empty pptx file', async () => {
    const out = path.join(os.tmpdir(), `sft-ppt-test-${Date.now()}.pptx`)
    tmpFiles.push(out)
    const htmlSidecar = out.replace(/\.pptx$/i, '.html')
    tmpFiles.push(htmlSidecar)

    const result = await convertHtmlToPptx({
      html: SAMPLE_HTML,
      outputPath: out,
      theme: 'simple',
      mediaBaseDir: os.tmpdir(),
      title: 'Test Deck',
    })

    expect(result.slideCount).toBe(3)
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.statSync(out).size).toBeGreaterThan(1000)
  })
})
