import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  applyFontsToHtml,
  collectParagraphFonts,
  cssFontFamily,
  enrichHtmlFonts
} from '../preview-fonts'
import { markdownToDocx } from '../styles'
import { officialPreset } from '../../chinese-document-official/presets'

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:eastAsia="仿宋"/>
      <w:sz w:val="32"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:rPr>
      <w:rFonts w:eastAsia="方正小标宋简体"/>
      <w:sz w:val="44"/>
      <w:b w:val="false"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="Heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr>
      <w:rFonts w:eastAsia="黑体"/>
      <w:sz w:val="32"/>
      <w:b w:val="false"/>
    </w:rPr>
  </w:style>
</w:styles>`

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Title"/></w:pPr>
      <w:r><w:t>国元证券股份有限公司关于进一步加强金融科技人才培养的通知</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>一、充分认识金融科技人才培养的重要意义</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>各单位要高度重视。</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`

describe('cssFontFamily', () => {
  it('expands official document faces to local aliases', () => {
    expect(cssFontFamily('方正小标宋简体')).toContain('方正小标宋简体')
    expect(cssFontFamily('方正小标宋简体')).toContain('华文中宋')
    expect(cssFontFamily('仿宋')).toContain('仿宋_GB2312')
    expect(cssFontFamily('仿宋')).toContain('STFangsong')
    expect(cssFontFamily('黑体')).toContain('SimHei')
  })

  it('quotes unknown faces without inventing a second name', () => {
    expect(cssFontFamily('MyCustomFace')).toBe("'MyCustomFace',serif")
  })
})

describe('collectParagraphFonts + applyFontsToHtml', () => {
  it('injects title / heading / body fonts from styles.xml', () => {
    const fonts = collectParagraphFonts(DOCUMENT, STYLES)
    expect(fonts).toHaveLength(3)
    expect(fonts[0].family).toContain('方正小标宋简体')
    expect(fonts[0].size).toBe('22pt')
    expect(fonts[0].weight).toBe('normal')
    expect(fonts[1].family).toContain('黑体')
    expect(fonts[2].family).toContain('仿宋')
    expect(fonts[2].size).toBe('16pt')
    expect(fonts[0].indent).toBe('0')
    expect(fonts[2].indent).toBe('0')

    const html = [
      '<h1 class="document-title">标题</h1>',
      ' <h1>一、充分认识</h1>',
      '<p>各单位要高度重视。</p>'
    ].join('')
    const out = applyFontsToHtml(html, fonts)
    expect(out).toMatch(/<h1 class="document-title" style="[^"]*font-family:[^"]*方正小标宋简体/)
    expect(out).toMatch(/font-weight:normal/)
    expect(out).toMatch(/<h1 style="[^"]*font-family:[^"]*黑体/)
    expect(out).toMatch(/<p style="[^"]*font-family:[^"]*仿宋/)
  })

  it('does not inject when paragraph count and HTML tags disagree', () => {
    const out = applyFontsToHtml(
      '<h1 class="document-title">标题</h1><p>正文</p>',
      [{ family: cssFontFamily('方正小标宋简体') }]
    )
    expect(out).not.toContain('font-family')
  })

  it('keeps 主送 flush and body first-line indented', () => {
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Title"/></w:pPr>
      <w:r><w:t>通知标题</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>各部门、各分支机构：</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:ind w:firstLine="640"/></w:pPr>
      <w:r><w:t>为深入贯彻落实公司科技赋能。</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`
    const fonts = collectParagraphFonts(document, STYLES)
    expect(fonts[1].indent).toBe('0')
    expect(fonts[2].indent).toBe('32pt')

    const out = applyFontsToHtml(
      '<h1 class="document-title">通知标题</h1><p>各部门、各分支机构：</p><p>为深入贯彻落实公司科技赋能。</p>',
      fonts
    )
    const paragraphs = [...out.matchAll(/<p[^>]*>/g)].map(m => m[0])
    expect(paragraphs[0]).toContain('text-indent:0')
    expect(paragraphs[1]).toContain('text-indent:32pt')
  })

  it('keeps an existing font-family on the tag', () => {
    const out = applyFontsToHtml(
      '<p style="font-family:Arial">hello</p>',
      [{ family: cssFontFamily('仿宋') }]
    )
    expect(out).toContain('font-family:Arial')
    expect(out).not.toContain('仿宋')
  })

  it('merges fonts onto alignment already injected', () => {
    const out = applyFontsToHtml(
      '<h1 class="document-title" style="text-align:center;text-indent:0">标题</h1>',
      [{ family: cssFontFamily('方正小标宋简体'), weight: 'normal' }]
    )
    expect(out).toContain('text-align:center')
    expect(out).toContain('方正小标宋简体')
    expect(out).toContain('font-weight:normal')
  })
})

describe('enrichHtmlFonts', () => {
  it('reads a docx buffer and writes fonts into preview HTML', async () => {
    const zip = new JSZip()
    zip.file('word/styles.xml', STYLES)
    zip.file('word/document.xml', DOCUMENT)
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    const html = '<h1 class="document-title">标题</h1><h1>一</h1><p>正文</p>'
    const out = await enrichHtmlFonts(html, buf)
    expect(out).toContain('方正小标宋简体')
    expect(out).toContain('黑体')
    expect(out).toContain('仿宋')
  })

  it('does not shift body fonts when the document has a list', async () => {
    const markdown = [
      '---',
      'title: 通知标题',
      '---',
      '',
      '# 一、章节',
      '',
      '正文一段。',
      '',
      '- 列表甲',
      '- 列表乙',
      '',
      '再一段正文。',
      '',
      '# 二、后面的章节'
    ].join('\n')
    const buf = await markdownToDocx(markdown, officialPreset)
    const mammoth = await import('mammoth')
    const { value: html } = await mammoth.convertToHtml(
      { buffer: buf },
      {
        styleMap: [
          "p[style-name='Title'] => h1.document-title:fresh",
          "p.Title => h1.document-title:fresh"
        ]
      }
    )
    const out = await enrichHtmlFonts(html, buf)
    const title = out.match(/<h1 class="document-title"[^>]*>/)?.[0] ?? ''
    const heading = [...out.matchAll(/<h1(?![^>]*document-title)[^>]*>/g)].at(-1)?.[0] ?? ''
    const paragraphs = [...out.matchAll(/<p[^>]*>/g)].map(m => m[0])
    expect(html).toMatch(/<li>/)
    expect(title).toContain('方正小标宋简体')
    expect(heading).toContain('黑体')
    expect(paragraphs.at(-1)).toContain('仿宋')
  })

  it('keeps official-document fonts after mammoth preview conversion', async () => {
    const markdown = [
      '---',
      'title: 国元证券股份有限公司关于进一步加强金融科技人才培养的通知',
      '---',
      '',
      '<p>各部门、各分支机构：</p>',
      '',
      '为深入贯彻落实公司科技赋能、创新驱动发展战略。',
      '',
      '# 一、充分认识金融科技人才培养的重要意义',
      '',
      '各单位要高度重视。'
    ].join('\n')
    const buf = await markdownToDocx(markdown, officialPreset)
    const mammoth = await import('mammoth')
    const { value: html } = await mammoth.convertToHtml(
      { buffer: buf },
      {
        styleMap: [
          "p[style-name='Title'] => h1.document-title:fresh",
          "p.Title => h1.document-title:fresh"
        ]
      }
    )
    const out = await enrichHtmlFonts(html, buf)
    const title = out.match(/<h1 class="document-title"[^>]*>/)?.[0] ?? ''
    const heading = out.match(/<h1(?![^>]*document-title)[^>]*>/)?.[0] ?? ''
    const paragraphs = [...out.matchAll(/<p[^>]*>/g)].map(m => m[0])
    expect(title).toContain('方正小标宋简体')
    expect(title).toContain('font-weight:normal')
    expect(heading).toContain('黑体')
    expect(paragraphs[0]).toContain('仿宋')
    expect(paragraphs[0]).toContain('text-indent:0')
    expect(paragraphs[1]).toContain('仿宋')
    expect(paragraphs[1]).toMatch(/text-indent:(?!0(?:;|"))/)
  })
})
