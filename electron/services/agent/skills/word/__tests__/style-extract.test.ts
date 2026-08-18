import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { extractStyleFromTemplate } from '../style-extract'

async function writeMinimalDocx(
  filePath: string,
  stylesXml: string,
  documentXml: string
): Promise<void> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
  )
  zip.file('word/styles.xml', stylesXml)
  zip.file('word/document.xml', documentXml)
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, buf)
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="NormalId">
    <w:name w:val="Normal"/>
    <w:pPr><w:jc w:val="both"/><w:spacing w:line="570" w:lineRule="exact"/>
      <w:ind w:firstLineChars="200"/></w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:eastAsia="仿宋"/>
      <w:sz w:val="32"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="TitleId">
    <w:name w:val="Title"/>
    <w:pPr><w:jc w:val="center"/></w:pPr>
    <w:rPr>
      <w:rFonts w:eastAsia="方正小标宋简体"/>
      <w:sz w:val="44"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="H1Id">
    <w:name w:val="heading 1"/>
    <w:rPr>
      <w:rFonts w:eastAsia="黑体"/>
      <w:sz w:val="32"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="H2Id">
    <w:name w:val="heading 2"/>
    <w:rPr>
      <w:rFonts w:eastAsia="楷体"/>
      <w:sz w:val="32"/>
      <w:b/>
    </w:rPr>
  </w:style>
</w:styles>`

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>test</w:t></w:r></w:p>
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="2098" w:right="1474" w:bottom="1984" w:left="1587"/>
    </w:sectPr>
  </w:body>
</w:document>`

describe('extractStyleFromTemplate', () => {
  it('extracts Normal, Title, headings and page margins from styles.xml', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-style-extract-'))
    const docxPath = path.join(dir, 'sample.docx')
    await writeMinimalDocx(docxPath, STYLES, DOCUMENT)

    const result = await extractStyleFromTemplate(docxPath)

    expect(result.sourceType).toBe('template')
    expect(result.config.font).toBe('仿宋')
    expect(result.config.fontAscii).toBe('Times New Roman')
    expect(result.config.fontSize).toBe(16)
    expect(result.config.lineSpacingFixed).toBe(28.5)
    expect(result.config.firstLineIndent).toBe(true)
    expect(result.config.firstLineIndentChars).toBe(2)
    expect(result.config.page?.marginTop).toBe(2098)
    expect(result.config.title?.font).toBe('方正小标宋简体')
    expect(result.config.title?.size).toBe(22)
    expect(result.config.headings?.[1]?.font).toBe('黑体')
    expect(result.config.headings?.[2]?.font).toBe('楷体')
    expect(result.config.headings?.[2]?.bold).toBe(true)
    expect(result.config.renderHr).toBe(false)
  })

  it('extracts styles from a .wps sample (OOXML)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-style-wps-'))
    const wpsPath = path.join(dir, 'sample.wps')
    await writeMinimalDocx(wpsPath, STYLES, DOCUMENT)

    const result = await extractStyleFromTemplate(wpsPath)
    expect(result.config.font).toBe('仿宋')
    expect(result.sourceType).toBe('template')
  })
})
