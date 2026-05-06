/**
 * markdownToDocx 图片支持测试
 *
 * 验证 ![alt](path) 在 Markdown → docx 转换中：
 * - 块级（独占段落）→ 居中嵌入图片
 * - 内联（段落内）→ 内联嵌入
 * - 文件不存在/远程 URL/SVG → 文字降级
 * - mediaBaseDir 解析相对路径
 * - 自定义尺寸（|WIDTHxHEIGHT 后缀 / title 写法）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import JSZip from 'jszip'
import { markdownToDocx } from '../styles'
// 注册副作用：让 securities / official 等公文样式可被解析
import '../../chinese-document-official'

// 1x1 透明 PNG（最小合法 PNG，67 字节）
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII='

let tmpDir: string
let imagePath: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-image-test-'))
  imagePath = path.join(tmpDir, 'pic.png')
  fs.writeFileSync(imagePath, Buffer.from(PNG_1X1_BASE64, 'base64'))
})

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

/**
 * 提取 docx 中的 document.xml 和 media 文件清单
 */
async function inspectDocx(buf: Buffer): Promise<{ documentXml: string; mediaFiles: string[]; allFiles: string[] }> {
  const zip = await JSZip.loadAsync(buf)
  const documentXml = (await zip.file('word/document.xml')?.async('string')) || ''
  const allFiles = Object.keys(zip.files)
  const mediaFiles = allFiles.filter(name => name.startsWith('word/media/'))
  return { documentXml, mediaFiles, allFiles }
}

describe('markdownToDocx: image embedding', () => {
  it('embeds a block-level image (standalone paragraph) using absolute path', async () => {
    const md = `# 标题\n\n![测试图](${imagePath})\n\n正文段落。`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, mediaFiles } = await inspectDocx(buf)

    expect(mediaFiles.length).toBeGreaterThan(0)
    expect(documentXml).toContain('<w:drawing>')
    // 块级图片应居中
    expect(documentXml).toContain('w:val="center"')
  })

  it('embeds a block-level image using relative path + mediaBaseDir', async () => {
    const md = `![测试图](pic.png)`
    const buf = await markdownToDocx(md, 'simple', { mediaBaseDir: tmpDir })
    const { documentXml, mediaFiles } = await inspectDocx(buf)

    expect(mediaFiles.length).toBeGreaterThan(0)
    expect(documentXml).toContain('<w:drawing>')
  })

  it('embeds an inline image in a paragraph with text', async () => {
    const md = `这是一段文字 ![](${imagePath}) 后面还有内容。`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, mediaFiles } = await inspectDocx(buf)

    expect(mediaFiles.length).toBeGreaterThan(0)
    expect(documentXml).toContain('<w:drawing>')
    expect(documentXml).toContain('这是一段文字')
    expect(documentXml).toContain('后面还有内容')
  })

  it('falls back to text when image file is missing', async () => {
    const md = `![缺失图](${path.join(tmpDir, 'not-exist.png')})`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, mediaFiles } = await inspectDocx(buf)

    expect(mediaFiles.length).toBe(0)
    expect(documentXml).not.toContain('<w:drawing>')
    expect(documentXml).toContain('图片缺失')
  })

  it('falls back to text for remote http URL', async () => {
    const md = `![远程图](https://example.com/pic.png)`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, mediaFiles } = await inspectDocx(buf)

    expect(mediaFiles.length).toBe(0)
    expect(documentXml).not.toContain('<w:drawing>')
    expect(documentXml).toContain('远程图')
  })

  it('parses size suffix |WIDTHxHEIGHT in alt text', async () => {
    const md = `![描述|200x100](${imagePath})`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, mediaFiles } = await inspectDocx(buf)

    expect(mediaFiles.length).toBeGreaterThan(0)
    // docx ImageRun 把像素尺寸转为 EMU 写到 cx/cy 属性，200×100 像素
    // 1px = 9525 EMU → 200px = 1905000，100px = 952500
    expect(documentXml).toMatch(/cx="1905000"/)
    expect(documentXml).toMatch(/cy="952500"/)
  })

  it('parses size in title attribute', async () => {
    const md = `![描述](${imagePath} "300x200")`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml } = await inspectDocx(buf)

    // 300px = 2857500 EMU，200px = 1905000 EMU
    expect(documentXml).toMatch(/cx="2857500"/)
    expect(documentXml).toMatch(/cy="1905000"/)
  })

  it('handles multiple images in one document', async () => {
    const md = `# 三张图\n\n![图一](${imagePath})\n\n![图二](${imagePath})\n\n![图三](${imagePath})`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, mediaFiles } = await inspectDocx(buf)

    // 三个 image token 应该产出 3 个 <w:drawing>（即使底层 media 文件去重）
    const drawings = documentXml.match(/<w:drawing>/g) || []
    expect(drawings.length).toBe(3)
    expect(mediaFiles.length).toBeGreaterThanOrEqual(1)
  })

  it('falls back to text for unsupported extension (.webp)', async () => {
    const webpPath = path.join(tmpDir, 'pic.webp')
    fs.writeFileSync(webpPath, Buffer.from(PNG_1X1_BASE64, 'base64')) // 内容是 PNG 字节，扩展名是 webp
    const md = `![动图](${webpPath})`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, mediaFiles } = await inspectDocx(buf)

    expect(mediaFiles.length).toBe(0)
    expect(documentXml).not.toContain('<w:drawing>')
    expect(documentXml).toContain('图片(格式不支持)')
  })

  it('falls back to null when relative path has no mediaBaseDir', async () => {
    const md = `![相对路径图](pic.png)`
    const buf = await markdownToDocx(md, 'simple') // 故意不传 mediaBaseDir
    const { documentXml, mediaFiles } = await inspectDocx(buf)

    expect(mediaFiles.length).toBe(0)
    expect(documentXml).not.toContain('<w:drawing>')
    expect(documentXml).toContain('相对路径图')
  })

  it('resolves file:// URL via fileURLToPath (cross-platform)', async () => {
    const fileUrl = 'file://' + imagePath
    const md = `![file URL 图](${fileUrl})`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, mediaFiles } = await inspectDocx(buf)

    expect(mediaFiles.length).toBeGreaterThan(0)
    expect(documentXml).toContain('<w:drawing>')
  })

  it('falls back to text for SVG (no PNG fallback provided)', async () => {
    const svgPath = path.join(tmpDir, 'pic.svg')
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const md = `![矢量图](${svgPath})`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, mediaFiles } = await inspectDocx(buf)

    expect(mediaFiles.length).toBe(0)
    expect(documentXml).toContain('图片(SVG)')
  })

  it('embeds image in a list item', async () => {
    const md = `- 项一: ![](${imagePath})\n- 项二: 文字`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, mediaFiles } = await inspectDocx(buf)

    expect(mediaFiles.length).toBeGreaterThan(0)
    expect(documentXml).toContain('<w:drawing>')
  })

  it('embeds image in a table cell', async () => {
    const md = `| 列1 | 列2 |\n|---|---|\n| 文字 | ![](${imagePath}) |`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, mediaFiles } = await inspectDocx(buf)

    expect(mediaFiles.length).toBeGreaterThan(0)
    expect(documentXml).toContain('<w:drawing>')
  })

  it('block image paragraph uses lineRule=auto (not EXACT) under fixed-line styles', async () => {
    // 公文样式（securities/official/regulation/meeting）的 Normal 段落用 lineRule:exact
    // 28.5pt 固定行距，块级图片若不显式覆盖会被压成一条线（用户实际反馈的 bug）。
    // 验证：securities 样式下，含图片的段落 spacing 必须是 lineRule="auto"。
    const md = `# 标题\n\n![测试图](${imagePath})\n\n正文段落。`
    const buf = await markdownToDocx(md, 'securities')
    const { documentXml } = await inspectDocx(buf)

    expect(documentXml).toContain('<w:drawing>')
    // 找到图片所在的 <w:p>...<w:drawing>...</w:p>，断言其 spacing 用了 lineRule="auto"
    // docx XML 里 <w:spacing w:line="240" w:lineRule="auto" .../>
    const imageParaMatch = documentXml.match(/<w:p[^>]*>[\s\S]*?<w:drawing>[\s\S]*?<\/w:p>/)
    expect(imageParaMatch).not.toBeNull()
    const imagePara = imageParaMatch![0]
    expect(imagePara).toMatch(/<w:spacing[^>]*w:lineRule="auto"/)
    expect(imagePara).not.toMatch(/<w:spacing[^>]*w:lineRule="exact"/)
  })

  it('block image paragraph keeps lineRule=auto under "official" style as well', async () => {
    const md = `![测试图](${imagePath})`
    const buf = await markdownToDocx(md, 'official')
    const { documentXml } = await inspectDocx(buf)

    const imageParaMatch = documentXml.match(/<w:p[^>]*>[\s\S]*?<w:drawing>[\s\S]*?<\/w:p>/)
    expect(imageParaMatch).not.toBeNull()
    expect(imageParaMatch![0]).toMatch(/<w:spacing[^>]*w:lineRule="auto"/)
  })
})

describe('markdownToDocx: image width cap (避免溢出 A4 版面)', () => {
  it('caps oversized image to page contentWidth (simple style ≈ 601px)', async () => {
    // simple 样式默认 A4 + 1in 边距：contentWidth = 11906 - 2880 = 9026 DXA = 601px
    // AI 显式给 2400x1800 大尺寸（容易因为图片源分辨率 2400x1800 直接抄过来）
    const md = `![大图|2400x1800](${imagePath})`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml } = await inspectDocx(buf)

    // cap 后 width = 601px, height = 1800 * (601/2400) = 451px
    // EMU: 601*9525 = 5724525, 451*9525 = 4295775
    expect(documentXml).toMatch(/cx="5724525"/)
    expect(documentXml).toMatch(/cy="4295775"/)
    // 不应保留原始 2400x1800（22860000x17145000 EMU）
    expect(documentXml).not.toMatch(/cx="22860000"/)
  })

  it('caps oversized image more tightly under securities style (≈ 589px)', async () => {
    // securities 用 OFFICIAL_MARGINS（左 28mm + 右 26mm = 3062 DXA），contentWidth ≈ 589px
    const md = `![大图|2400x1800](${imagePath})`
    const buf = await markdownToDocx(md, 'securities')
    const { documentXml } = await inspectDocx(buf)

    // 589*9525 = 5610225
    expect(documentXml).toMatch(/cx="5610225"/)
    // 显著小于 simple 样式下的 cap (601*9525 = 5724525)
    expect(documentXml).not.toMatch(/cx="5724525"/)
  })

  it('does NOT upscale small images (keep |200x100 as-is)', async () => {
    const md = `![小图|200x100](${imagePath})`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml } = await inspectDocx(buf)

    expect(documentXml).toMatch(/cx="1905000"/)
    expect(documentXml).toMatch(/cy="952500"/)
  })

  it('default-size images (no |WxH) remain 480x360, unaffected by cap', async () => {
    const md = `![无尺寸](${imagePath})`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml } = await inspectDocx(buf)

    // 480*9525 = 4572000, 360*9525 = 3429000
    expect(documentXml).toMatch(/cx="4572000"/)
    expect(documentXml).toMatch(/cy="3429000"/)
  })
})

describe('markdownToDocx: CommonMark wrapped <> path (用户必须显式包裹)', () => {
  let spacedDir: string
  let spacedImagePath: string

  beforeAll(() => {
    spacedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'word image space '))
    const sub = path.join(spacedDir, 'Application Support', 'agent workspace')
    fs.mkdirSync(sub, { recursive: true })
    spacedImagePath = path.join(sub, '布局总览.png')
    fs.writeFileSync(spacedImagePath, Buffer.from(PNG_1X1_BASE64, 'base64'))
  })

  afterAll(() => {
    try {
      fs.rmSync(spacedDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('embeds image when path is wrapped with <> (CommonMark spec)', async () => {
    // 含空格路径必须由 AI 自己用 <> 包裹（已写入 word skill 提示）
    const md = `# 标题\n\n![国元股权基金布局总览](<${spacedImagePath}>)\n\n正文`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, mediaFiles } = await inspectDocx(buf)

    expect(mediaFiles.length).toBeGreaterThan(0)
    expect(documentXml).toContain('<w:drawing>')
    expect(documentXml).not.toMatch(/!\[国元股权基金布局总览\]/)
  })

  it('handles inline image with wrapped spaced path', async () => {
    const md = `这是行内图片 ![小图](<${spacedImagePath}>) 跟在文字后面。`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, mediaFiles } = await inspectDocx(buf)

    expect(mediaFiles.length).toBeGreaterThan(0)
    expect(documentXml).toContain('<w:drawing>')
  })
})
