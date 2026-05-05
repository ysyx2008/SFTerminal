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
