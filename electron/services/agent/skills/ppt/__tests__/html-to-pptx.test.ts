import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  applyBackground,
  applyElements,
  renderHtmlToPptx,
  wrapSlideHtml,
  DECK_SIZES,
  type SlideData,
} from '../html-render-pptx'
import { buildPreviewDocument } from '../preview'
import { detectBrowser } from '../../browser/detector'

// --- 假的 PptxGenJS slide / pres，用来断言纯映射器的行为 ---
function makeFakeSlide() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls: { addText: any[]; addImage: any[]; addShape: any[] } = {
    addText: [],
    addImage: [],
    addShape: [],
  }
  const slide = {
    background: undefined as unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addText: (...a: any[]) => calls.addText.push(a),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addImage: (...a: any[]) => calls.addImage.push(a),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addShape: (...a: any[]) => calls.addShape.push(a),
  }
  return { slide, calls }
}
const fakePres = { ShapeType: { line: 'line', rect: 'rect', roundRect: 'roundRect' } }

describe('applyBackground / applyElements (纯映射器)', () => {
  it('maps color background', () => {
    const { slide } = makeFakeSlide()
    applyBackground(slide as never, { background: { type: 'color', value: '1E2761' } } as SlideData)
    expect(slide.background).toEqual({ color: '1E2761' })
  })

  it('maps text / shape / image / list elements', () => {
    const { slide, calls } = makeFakeSlide()
    const data: SlideData = {
      width: 1280,
      height: 720,
      background: { type: 'color', value: 'FFFFFF' },
      placeholders: [],
      errors: [],
      elements: [
        {
          type: 'shape',
          text: '',
          position: { x: 1, y: 1, w: 3, h: 2 },
          shape: { fill: 'F8FAFC', transparency: null, line: null, rectRadius: 0.15, shadow: null },
        },
        {
          type: 'h1',
          text: '标题',
          position: { x: 0.5, y: 0.5, w: 8, h: 0.6 },
          style: { fontSize: 40, fontFace: 'Microsoft YaHei', color: '1E2761', align: 'left', bold: true },
        },
        { type: 'image', src: 'file:///tmp/a.png', position: { x: 5, y: 1, w: 2, h: 2 } },
        {
          type: 'list',
          items: [{ text: '项', options: { bullet: true } }],
          position: { x: 1, y: 3, w: 6, h: 2 },
          style: { fontSize: 18, fontFace: 'Arial', color: '333333', align: 'left' },
        },
      ],
    }
    applyElements(slide as never, data, fakePres as never)
    // 1 个 shape（用 addText 承载）+ 1 个 h1 文本 + 1 个 list = 3 次 addText
    expect(calls.addText.length).toBe(3)
    expect(calls.addImage.length).toBe(1)
    // 图片路径去掉 file://
    expect(calls.addImage[0][0].path).toBe('/tmp/a.png')
    // roundRect（rectRadius > 0）
    expect(calls.addText[0][1].shape).toBe('roundRect')
  })
})

describe('wrapSlideHtml / buildPreviewDocument', () => {
  it('wraps inner html with sized body', () => {
    const html = wrapSlideHtml('<p>hi</p>', 'p{color:red}', DECK_SIZES.widescreen)
    expect(html).toContain('width:1280px')
    expect(html).toContain('<p>hi</p>')
    expect(html).toContain('p{color:red}')
  })

  it('builds a multi-slide preview document', () => {
    const doc = buildPreviewDocument(['<p>a</p>', '<p>b</p>'], '', 'widescreen')
    expect(doc).toContain('共 2 页')
    expect(doc.match(/class="slide-frame"/g)?.length).toBe(2)
  })
})

describe('renderHtmlToPptx', () => {
  it('rejects empty slides', async () => {
    await expect(
      renderHtmlToPptx({ slides: ['  '], outputPath: '/tmp/x.pptx' })
    ).rejects.toThrow(/NO_SLIDES/)
  })

  // 真渲染依赖系统浏览器（CLI/node 走 playwright-core）。有浏览器才跑。
  const hasBrowser = !!detectBrowser()
  const tmpFiles: string[] = []
  afterEach(() => {
    for (const f of tmpFiles) { try { fs.unlinkSync(f) } catch { /* ignore */ } }
    tmpFiles.length = 0
  })

  it.runIf(hasBrowser)('renders real slides to a non-empty pptx', async () => {
    const out = path.join(os.tmpdir(), `sft-ppt-render-${Date.now()}.pptx`)
    tmpFiles.push(out)
    const result = await renderHtmlToPptx({
      slides: [
        `<div class="bg" style="background:#1E2761"></div>
         <h1 style="position:absolute;left:80px;top:250px;width:1000px;font-size:56px;color:#fff">测试封面</h1>`,
        `<div class="bg" style="background:#fff"></div>
         <h2 style="position:absolute;left:80px;top:80px;width:1000px;font-size:32px;color:#1E2761">要点</h2>
         <ul style="position:absolute;left:80px;top:180px;width:1000px;font-size:20px;color:#333">
           <li>第一项</li><li>第二项</li></ul>`,
      ],
      outputPath: out,
      title: 'Test Deck',
    })
    expect(result.slideCount).toBe(2)
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.statSync(out).size).toBeGreaterThan(1000)
  }, 30000)
})
