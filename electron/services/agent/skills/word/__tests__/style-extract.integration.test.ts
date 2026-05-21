import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { extractStyleFromTemplate } from '../style-extract'
import { markdownToDocx } from '../styles'

const PARTY_FORMAT_DOCX =
  '/Users/yushen/Library/CloudStorage/OneDrive-个人/文档/2026-05-20党委会议案要求/附件2.党委会议案格式.docx'

async function readStyleFromGeneratedDocx(
  docxPath: string,
  styleId: 'Title' | 'Heading1'
): Promise<{ font?: string; sizeHalfPt?: string }> {
  const zip = await JSZip.loadAsync(fs.readFileSync(docxPath))
  const stylesXml = await zip.file('word/styles.xml')!.async('string')
  const block = stylesXml.match(
    new RegExp(`<w:style w:type="paragraph" w:styleId="${styleId}">[\\s\\S]*?<\\/w:style>`)
  )?.[0]
  if (!block) return {}
  const font = block.match(/w:eastAsia="([^"]+)"/)?.[1]
  const sizeHalfPt = block.match(/<w:sz w:val="(\d+)"/)?.[1]
  return { font, sizeHalfPt }
}

describe('extractStyleFromTemplate integration', () => {
  it('maps custom 中心组 style to document title', async () => {
    const hasFile = fs.existsSync(PARTY_FORMAT_DOCX)
    if (!hasFile) {
      console.warn('skip: party format docx not on this machine')
      return
    }
    const extracted = await extractStyleFromTemplate(PARTY_FORMAT_DOCX)
    expect(extracted.config.title?.font).toBe('方正小标宋简体')
    expect(extracted.config.title?.size).toBe(22)
    expect(extracted.config.page?.marginTop).toBe(2098)
    expect(extracted.config.page?.marginLeft).toBe(1587)
  })

  it('extracted style produces docx with matching Title/Heading fonts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-style-e2e-'))
    const templatePath = path.join(dir, 'template.docx')
    const outPath = path.join(dir, 'out.docx')

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="N"><w:name w:val="Normal"/>
    <w:rPr><w:rFonts w:eastAsia="仿宋" w:ascii="Times New Roman"/><w:sz w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="T"><w:name w:val="Title"/>
    <w:pPr><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="方正小标宋简体"/><w:sz w:val="44"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="H1"><w:name w:val="heading 1"/>
    <w:rPr><w:rFonts w:eastAsia="黑体"/><w:sz w:val="32"/></w:rPr>
  </w:style>
</w:styles>`
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:sectPr><w:pgSz w:w="11906" w:h="16838"/>
    <w:pgMar w:top="2098" w:right="1474" w:bottom="1984" w:left="1587"/></w:sectPr></w:body>
</w:document>`

    const zip = new JSZip()
    zip.file('word/styles.xml', stylesXml)
    zip.file('word/document.xml', documentXml)
    fs.writeFileSync(templatePath, await zip.generateAsync({ type: 'nodebuffer' }))

    const styleConfig = await extractStyleFromTemplate(templatePath)
    const md = `---
title: 关于测试的议案
---

# 一、背景

正文段落测试。
`
    const buffer = await markdownToDocx(md, styleConfig)
    fs.writeFileSync(outPath, buffer)

    expect(fs.existsSync(outPath)).toBe(true)
    const title = await readStyleFromGeneratedDocx(outPath, 'Title')
    const h1 = await readStyleFromGeneratedDocx(outPath, 'Heading1')
    expect(title.font).toBe('方正小标宋简体')
    expect(title.sizeHalfPt).toBe('44')
    expect(h1.font).toBe('黑体')
    expect(h1.sizeHalfPt).toBe('32')
  })
})
