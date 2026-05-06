/**
 * 企业制度文件样式预设
 *
 * 章→节→条→款/项 四级编号体系，参照立法技术规范。
 * 历史上定义在 word/styles.ts 的 PRESET_STYLES 里，拆分后由本技能通过
 * registerStylePreset 注入共享注册表。
 */
import type { WordStyleConfig } from '../word/styles'

// 企业制度文件（章→节→条→款/项，参照立法技术规范编号体系）
export const regulationPreset: WordStyleConfig = {
  name: '制度文件',
  sourceType: 'preset',
  config: {
    page: {
      size: 'a4',
      marginTop: 1440,
      marginBottom: 1440,
      marginLeft: 1800,
      marginRight: 1800
    },
    font: '仿宋',
    fontAscii: '仿宋',
    fontSize: 12,
    lineSpacing: 1.5,
    textAlign: 'justify',
    firstLineIndent: true,
    firstLineIndentChars: 2,
    renderHr: false,
    title: { font: '黑体', fontAscii: '黑体', size: 15, bold: true, align: 'center' },
    headings: {
      1: { font: '仿宋', fontAscii: '仿宋', size: 12, bold: true, align: 'center' },
      2: { font: '仿宋', fontAscii: '仿宋', size: 12, bold: true, align: 'center' },
      3: { font: '仿宋', fontAscii: '仿宋', size: 12, bold: false, indent: 2, spacingBefore: 0, spacingAfter: 0 },
      4: { font: '仿宋', fontAscii: '仿宋', size: 12, bold: false, indent: 2, spacingBefore: 0, spacingAfter: 0 },
      5: { font: '仿宋', fontAscii: '仿宋', size: 12, bold: false },
      6: { font: '仿宋', fontAscii: '仿宋', size: 12, bold: false }
    },
    multiLevelNumbering: {
      levels: [
        // Level 0: 章 — "第一章"、"第二章"...（段落居中由 Heading1 样式控制）
        { format: 'chineseCounting', text: '第%1章\u3000', alignment: 'left', indent: { left: 0, hanging: 0 }, run: { bold: true } },
        // Level 1: 节 — "第一节"、"第二节"...（段落居中由 Heading2 样式控制）
        { format: 'chineseCounting', text: '第%2节\u3000', alignment: 'left', indent: { left: 0, hanging: 0 }, run: { bold: true } },
        // Level 2: 条 — "第一条"、"第二条"...（跨章连续编号）
        { format: 'chineseCounting', text: '第%3条\u3000', restart: 0, indent: { firstLine: 480 }, run: { bold: true } },
        // Level 3: 款 — "（一）"、"（二）"...（每条重新开始）
        { format: 'chineseCounting', text: '\uff08%4\uff09', indent: { firstLine: 480 } },
        // Level 4: 项 — "1．"、"2．"...（每款重新开始）
        { format: 'decimal', text: '%5\uff0e', indent: { firstLine: 480 } }
      ]
    },
    numberingRules: [
      { pattern: '^第[一二三四五六七八九十百千万]+章', style: { headingLevel: 1, numberingLevel: 0, indent: 0 } },
      { pattern: '^第[一二三四五六七八九十百]+节', style: { headingLevel: 2, numberingLevel: 1, indent: 0 } },
      { pattern: '^第[一二三四五六七八九十百千万]+条', style: { headingLevel: 3, numberingLevel: 2, indent: 0 } },
      { pattern: '^（[一二三四五六七八九十]+）', style: { headingLevel: 4, numberingLevel: 3, indent: 0 } },
      { pattern: '^\\d+[.．\uff0e]', style: { numberingLevel: 4, indent: 0 } }
    ],
    table: {
      headerBackground: 'F2F2F2',
      headerBold: true,
      headerAlign: 'center',
      borderColor: '000000',
      borderSize: 4,
      font: '仿宋',
      fontAscii: '仿宋',
      fontSize: 10.5
    },
    codeBlock: { font: 'Courier New', fontSize: 10, background: 'F5F5F5' },
    blockquote: { borderColor: '999999', italic: false, color: '333333' }
  }
}

