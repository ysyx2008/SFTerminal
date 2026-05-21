/**
 * 手动验证 word 样式提取 + 生成链路（非 vitest）
 * 用法: npx tsx scripts/test-word-style-extract.ts
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import JSZip from 'jszip'
import {
  extractStyleFromTemplate,
  summarizeExtractedConfig
} from '../electron/services/agent/skills/word/style-extract'
import { markdownToDocx } from '../electron/services/agent/skills/word/styles'

const PARTY_FORMAT_DOCX =
  '/Users/yushen/Library/CloudStorage/OneDrive-个人/文档/2026-05-20党委会议案要求/附件2.党委会议案格式.docx'

function ok(cond: boolean, msg: string) {
  console.log(cond ? `  ✅ ${msg}` : `  ❌ ${msg}`)
  if (!cond) process.exitCode = 1
}

async function main() {
  console.log('=== 1. 单元样板：完整 Normal/Title/Heading ===\n')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-word-style-test-'))
  const templatePath = path.join(dir, 'full-template.docx')
  const stylesXml = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="N"><w:name w:val="Normal"/>
    <w:pPr><w:spacing w:line="570" w:lineRule="exact"/><w:ind w:firstLineChars="200"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="仿宋" w:ascii="Times New Roman"/><w:sz w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="T"><w:name w:val="Title"/>
    <w:rPr><w:rFonts w:eastAsia="方正小标宋简体"/><w:sz w:val="44"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="H1"><w:name w:val="heading 1"/>
    <w:rPr><w:rFonts w:eastAsia="黑体"/><w:sz w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="H2"><w:name w:val="heading 2"/>
    <w:rPr><w:rFonts w:eastAsia="楷体"/><w:sz w:val="32"/><w:b/></w:rPr>
  </w:style>
</w:styles>`
  const documentXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:sectPr><w:pgSz w:w="11906" w:h="16838"/>
  <w:pgMar w:top="2098" w:right="1474" w:bottom="1984" w:left="1587"/></w:sectPr></w:body>
</w:document>`
  const zip = new JSZip()
  zip.file('word/styles.xml', stylesXml)
  zip.file('word/document.xml', documentXml)
  fs.writeFileSync(templatePath, await zip.generateAsync({ type: 'nodebuffer' }))

  const extracted = await extractStyleFromTemplate(templatePath)
  ok(extracted.config.font === '仿宋', '正文仿宋')
  ok(extracted.config.fontSize === 16, '正文 16pt')
  ok(extracted.config.lineSpacingFixed === 28.5, '固定行距 28.5pt')
  ok(extracted.config.title?.font === '方正小标宋简体', '标题方正小标宋')
  ok(extracted.config.title?.size === 22, '标题 22pt')
  ok(extracted.config.headings?.[1]?.font === '黑体', '一级标题黑体')
  ok(extracted.config.headings?.[2]?.bold === true, '二级标题加粗')

  const outPath = path.join(dir, 'generated.docx')
  const buffer = await markdownToDocx(
    '---\ntitle: 测试议案\n---\n\n# 一、议题\n\n正文。',
    extracted
  )
  fs.writeFileSync(outPath, buffer)
  ok(fs.existsSync(outPath), 'markdownToDocx 生成文件')
  const outZip = await JSZip.loadAsync(fs.readFileSync(outPath))
  const outStyles = await outZip.file('word/styles.xml')!.async('string')
  const titleBlock = outStyles.match(
    /<w:style w:type="paragraph" w:styleId="Title">[\s\S]*?<\/w:style>/
  )?.[0]
  ok(!!titleBlock?.includes('方正小标宋简体'), 'Title 样式含方正小标宋')
  ok(titleBlock?.includes('<w:sz w:val="44"') ?? false, 'Title 字号 44 half-pt (22pt)')
  const h1Block = outStyles.match(
    /<w:style w:type="paragraph" w:styleId="Heading1">[\s\S]*?<\/w:style>/
  )?.[0]
  ok(!!h1Block?.includes('黑体'), 'Heading1 样式含黑体')
  console.log('\n提取摘要:\n' + summarizeExtractedConfig(extracted.config))

  console.log('\n=== 2. 用户附件2（格式说明 docx）===\n')
  if (!fs.existsSync(PARTY_FORMAT_DOCX)) {
    console.log('  ⏭ 跳过：附件2 不在本机')
    return
  }
  const party = await extractStyleFromTemplate(PARTY_FORMAT_DOCX)
  ok(party.config.page?.marginTop === 2098, '页边距 top=2098 (37mm)')
  ok(party.config.title?.font === '方正小标宋简体', '中心组 → 文档标题样式')
  ok(party.config.title?.size === 22, '标题二号(22pt)')
  console.log('\n提取摘要:\n' + summarizeExtractedConfig(party.config))
  console.log('\n说明: 附件2 为文字版式说明，Normal 未设仿宋三号，heading 不完整属预期。')

  console.log('\n=== 完成 ===\n')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
