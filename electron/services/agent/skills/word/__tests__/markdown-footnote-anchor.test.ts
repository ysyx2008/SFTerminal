/**
 * markdownToDocx 脚注 + 文档内跳转测试
 *
 * 覆盖：
 * - GFM 脚注语法 [^id] / [^id]: 内容 → docx FootnoteReferenceRun + 真正的 footnotes 部件
 * - 标题自动包 Bookmark
 * - [文](#anchor) → InternalHyperlink
 * - 跨多次调用复用扩展（marked.use 守卫）
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { markdownToDocx } from '../styles'

async function inspect(buf: Buffer): Promise<{
  documentXml: string
  footnotesXml: string
  allFiles: string[]
}> {
  const zip = await JSZip.loadAsync(buf)
  const documentXml = (await zip.file('word/document.xml')?.async('string')) || ''
  const footnotesXml = (await zip.file('word/footnotes.xml')?.async('string')) || ''
  return { documentXml, footnotesXml, allFiles: Object.keys(zip.files) }
}

describe('markdownToDocx: footnotes', () => {
  it('embeds a single footnote with reference and content', async () => {
    const md = `这是正文[^1]。\n\n[^1]: 这是脚注内容`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, footnotesXml } = await inspect(buf)

    expect(documentXml).toContain('<w:footnoteReference')
    expect(footnotesXml).toContain('这是脚注内容')
    // 正文里"这是正文"还在
    expect(documentXml).toContain('这是正文')
    // 正文里不应包含脚注定义文字
    expect(documentXml).not.toContain('这是脚注内容')
  })

  it('handles multiple footnotes and assigns sequential ids', async () => {
    const md = `第一段[^a]。\n\n第二段[^b]，又来一个[^a]。\n\n[^a]: 脚注 A\n[^b]: 脚注 B`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, footnotesXml } = await inspect(buf)

    expect(footnotesXml).toContain('脚注 A')
    expect(footnotesXml).toContain('脚注 B')
    // 同一个 label 多次引用应共享同一个 id（去重，文档里出现两次 reference）
    const refs = documentXml.match(/<w:footnoteReference/g) || []
    expect(refs.length).toBe(3) // a, b, a 共 3 次引用
  })

  it('falls back gracefully when ref points to undefined footnote', async () => {
    const md = `引用了不存在的脚注[^missing]。`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml } = await inspect(buf)

    // 没有真正的 footnoteReference 元素
    expect(documentXml).not.toContain('<w:footnoteReference')
    // 文字降级，原 [^missing] 出现在正文里
    expect(documentXml).toContain('[^missing]')
  })

  it('survives multiple invocations without duplicating extension registrations', async () => {
    // 第一次调用注册扩展，后续应该还能正常解析（不会因 marked.use 叠加而出错）
    const md = `测试[^x]\n\n[^x]: 内容`
    const buf1 = await markdownToDocx(md, 'simple')
    const buf2 = await markdownToDocx(md, 'simple')
    const buf3 = await markdownToDocx(md, 'simple')
    expect(buf1).toBeInstanceOf(Buffer)
    expect(buf2).toBeInstanceOf(Buffer)
    expect(buf3).toBeInstanceOf(Buffer)
    const { documentXml } = await inspect(buf3)
    expect(documentXml).toContain('<w:footnoteReference')
  })
})

describe('markdownToDocx: heading bookmarks & internal links', () => {
  it('auto-bookmarks each heading with slugified anchor', async () => {
    const md = `# 第一章 总则\n\n## 第二节 范围\n\n正文`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml } = await inspect(buf)

    // 标题段落里应该有 bookmarkStart
    expect(documentXml).toContain('<w:bookmarkStart')
    expect(documentXml).toContain('<w:bookmarkEnd')
    // anchor 名称取自 slugify
    expect(documentXml).toMatch(/w:name="第一章-总则"/)
    expect(documentXml).toMatch(/w:name="第二节-范围"/)
  })

  it('renders [text](#anchor) as internal hyperlink to existing heading', async () => {
    const md = `# 总则\n\n参见[总则](#总则)章节。`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml } = await inspect(buf)

    expect(documentXml).toContain('<w:hyperlink')
    expect(documentXml).toMatch(/w:anchor="总则"/)
    // 链接文字仍在正文里
    expect(documentXml).toContain('参见')
    expect(documentXml).toContain('章节')
  })

  it('still renders external links as plain blue underlined text', async () => {
    const md = `访问 [示例](https://example.com)`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml } = await inspect(buf)

    // 不应该用 InternalHyperlink
    expect(documentXml).not.toContain('w:hyperlink')
    // 文字 + 颜色 + 下划线
    expect(documentXml).toContain('示例')
    expect(documentXml).toContain('w:val="0066CC"')
    expect(documentXml).toContain('<w:u w:val="single"')
  })

  it('does not crash when internal link points to non-existent anchor', async () => {
    const md = `点击[这里](#不存在的锚)跳转。`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml } = await inspect(buf)

    // 仍然渲染为 hyperlink（Word 打开时 anchor 找不到就提示，不会让我们的转换流程失败）
    expect(documentXml).toContain('<w:hyperlink')
    expect(documentXml).toContain('点击')
    expect(documentXml).toContain('跳转')
  })

  it('slug excludes inline formatting markers', async () => {
    const md = `# **重点** 内容\n\n[跳转](#重点-内容)`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml } = await inspect(buf)

    expect(documentXml).toMatch(/w:name="重点-内容"/)
    expect(documentXml).toMatch(/w:anchor="重点-内容"/)
  })

  it('disambiguates duplicate heading slugs with -2/-3 suffix', async () => {
    const md = `# 附录\n\n第一个附录\n\n# 附录\n\n第二个附录\n\n# 附录\n\n第三个`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml } = await inspect(buf)

    // 三个 bookmark name 应该是 附录 / 附录-2 / 附录-3
    expect(documentXml).toMatch(/w:name="附录"/)
    expect(documentXml).toMatch(/w:name="附录-2"/)
    expect(documentXml).toMatch(/w:name="附录-3"/)
  })
})

describe('markdownToDocx: edge cases', () => {
  it('treats \\[^x] as literal text, not footnote ref', async () => {
    const md = `转义示例：\\[^x] 不是脚注引用。`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml } = await inspect(buf)

    // 不应生成脚注引用
    expect(documentXml).not.toContain('<w:footnoteReference')
    // 字面量保留
    expect(documentXml).toContain('[')
    expect(documentXml).toContain('^x]')
  })

  it('collects footnote definitions nested in blockquote', async () => {
    const md = `正文[^q]。\n\n> [^q]: 引用块里的脚注定义`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, footnotesXml } = await inspect(buf)

    // 引用应该正常生成，定义被收集
    expect(documentXml).toContain('<w:footnoteReference')
    expect(footnotesXml).toContain('引用块里的脚注定义')
  })

  it('collects footnote definitions nested in list item', async () => {
    const md = `正文[^l]。\n\n- 列表项\n  [^l]: 列表里的定义`
    const buf = await markdownToDocx(md, 'simple')
    const { documentXml, footnotesXml } = await inspect(buf)

    expect(documentXml).toContain('<w:footnoteReference')
    expect(footnotesXml).toContain('列表里的定义')
  })

  it('handles empty heading and numeric heading slugs gracefully', async () => {
    const md = `# 1.0 概述\n\n# \n\n# 2.0 概述`
    const buf = await markdownToDocx(md, 'simple')
    // 不该崩；空标题会回退成 section
    const { documentXml } = await inspect(buf)
    expect(documentXml).toMatch(/w:name="a-1-0-概述"/)  // 数字开头加 a- 前缀
    expect(documentXml).toMatch(/w:name="section"/)
  })
})
