/**
 * 中国党政机关公文样式预设（GB/T 9704-2012）
 *
 * 历史上这三个预设和会议纪要预设都直接定义在 word/styles.ts 的 PRESET_STYLES 里，
 * 拆分到 chinese-document-official 技能后通过 word/styles.ts 的 registerStylePreset
 * 注入共享注册表。机制（解析引擎）继续在 word 技能里，本文件只承载策略数据。
 */
import type { WordStyleConfig } from '../word/styles'

/**
 * GB/T 9704 公文页边距（mm → DXA：1mm ≈ 56.7 DXA）
 *
 * 字段名必须用 PageConfig 的 marginTop/marginBottom/marginLeft/marginRight，
 * 历史上误写为 top/bottom/left/right 导致 ...展开后字段对不上、公文边距实际从未
 * 生效（一直 fallback 到 1in = 1440 DXA 的默认值）。
 */
const OFFICIAL_MARGINS = {
  marginTop: Math.round(37 * 56.7),    // 37mm
  marginBottom: Math.round(35 * 56.7), // 35mm
  marginLeft: Math.round(28 * 56.7),   // 28mm
  marginRight: Math.round(26 * 56.7)   // 26mm
}

// 中国党政机关公文格式 (GB/T 9704-2012)
export const officialPreset: WordStyleConfig = {
  name: '公文格式',
  sourceType: 'preset',
  config: {
    page: { size: 'a4', ...OFFICIAL_MARGINS },
    font: '仿宋',
    fontAscii: 'Times New Roman',
    fontSize: 16,
    lineSpacingFixed: 28.5,
    firstLineIndent: true,
    firstLineIndentChars: 2,
    renderHr: false,
    title: { font: '方正小标宋简体', size: 22, bold: false, align: 'center' },
    headings: {
      1: { font: '黑体', size: 16, bold: false },
      2: { font: '楷体', size: 16, bold: true },
      3: { font: '仿宋', size: 16, bold: true },
      4: { font: '仿宋', size: 16, bold: false },
      5: { font: '仿宋', size: 16, bold: false },
      6: { font: '仿宋', size: 16, bold: false }
    },
    // 不设 numberingRules：标题层级由 markdown # 显式标记，正文里以编号开头的并列项
    // （如"（一）组织保障。说明…"）走默认 Normal 样式（首行缩进 2 字符），
    // 符合公文行文习惯。
    table: {
      headerBackground: 'F2F2F2',
      headerBold: true,
      headerAlign: 'center',
      borderColor: '000000',
      borderSize: 4,
      font: '仿宋',
      fontAscii: 'Times New Roman',
      fontSize: 12
    },
    codeBlock: { font: 'Courier New', fontSize: 10, background: 'F5F5F5' },
    blockquote: { borderColor: '999999', italic: true, color: '333333' }
  }
}

// 证券公司公文格式（参照 GB/T 9704-2012 及国元证券公文处理规范）
export const securitiesPreset: WordStyleConfig = {
  name: '证券公文',
  sourceType: 'preset',
  config: {
    page: { size: 'a4', ...OFFICIAL_MARGINS },
    font: '仿宋_GB2312',
    fontAscii: 'Times New Roman',
    fontSize: 16,
    lineSpacingFixed: 28.5,
    firstLineIndent: true,
    firstLineIndentChars: 2,
    renderHr: false,
    title: { font: '方正小标宋简体', size: 22, bold: false, align: 'center' },
    headings: {
      1: { font: '黑体', size: 16, bold: false },
      2: { font: '楷体_GB2312', size: 16, bold: true },
      3: { font: '仿宋_GB2312', size: 16, bold: true },
      4: { font: '仿宋_GB2312', size: 16, bold: false },
      5: { font: '仿宋_GB2312', size: 16, bold: false },
      6: { font: '仿宋_GB2312', size: 16, bold: false }
    },
    // 见 official 样式注释：标题层级由 markdown # 决定，正文段走 Normal 样式获得首行缩进
    table: {
      headerBackground: 'F2F2F2',
      headerBold: true,
      headerAlign: 'center',
      borderColor: '000000',
      borderSize: 4,
      font: '仿宋_GB2312',
      fontAscii: 'Times New Roman',
      fontSize: 12
    },
    codeBlock: { font: 'Courier New', fontSize: 10, background: 'F5F5F5' },
    blockquote: { borderColor: '999999', italic: true, color: '333333' }
  }
}

// 会议纪要（中国企业常用格式）
export const meetingPreset: WordStyleConfig = {
  name: '会议纪要',
  sourceType: 'preset',
  config: {
    page: { size: 'a4', ...OFFICIAL_MARGINS },
    font: '仿宋',
    fontAscii: 'Times New Roman',
    fontSize: 16,
    lineSpacingFixed: 28.5,
    firstLineIndent: true,
    firstLineIndentChars: 2,
    renderHr: false,
    title: { font: '方正小标宋简体', size: 22, bold: false, align: 'center' },
    headings: {
      1: { font: '黑体', size: 16, bold: false },
      2: { font: '楷体', size: 16, bold: true },
      3: { font: '仿宋', size: 16, bold: true },
      4: { font: '仿宋', size: 16, bold: false },
      5: { font: '仿宋', size: 16, bold: false },
      6: { font: '仿宋', size: 16, bold: false }
    },
    // 见 official 样式注释：标题层级由 markdown # 决定，正文段走 Normal 样式获得首行缩进
    table: {
      headerBackground: 'E7E6E6',
      headerBold: true,
      headerAlign: 'center',
      borderColor: '000000',
      borderSize: 4,
      font: '仿宋',
      fontAscii: 'Times New Roman',
      fontSize: 12
    },
    codeBlock: { font: 'Courier New', fontSize: 10, background: 'F5F5F5' },
    blockquote: { borderColor: '999999', italic: false, color: '333333' }
  }
}

