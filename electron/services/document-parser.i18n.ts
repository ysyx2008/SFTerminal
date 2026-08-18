/**
 * 文档解析服务国际化翻译
 * 用于 document-parser.service.ts 的用户可见文本
 */

import { ConfigService } from './config.service'

type TranslationKey = keyof typeof translations['zh-CN']

const translations = {
  'zh-CN': {
    // 文件大小与跳过
    'doc.file_not_found': '文件不存在: {path}',
    'doc.file_too_large': '[{name} 文件较大（{size}），已跳过内容读取]',
    'doc.content_truncated': '\n\n... [内容已截断，原文共 {length} 字符]',
    'doc.parse_failed': '解析失败',

    // PDF 错误
    'doc.scan_pdf_error': 'PDF 共 {pages} 页，但未能提取到文本内容。该文件可能是扫描件或图片型 PDF。',
    'doc.empty_pdf_error': 'PDF 文件为空或格式不支持',

    // 缺少解析库
    'doc.mammoth_not_installed': 'Word 解析库未安装，请运行: npm install mammoth',
    'doc.word_extractor_not_installed': 'Word (.doc) 解析库未安装，请运行: npm install word-extractor',
    'doc.exceljs_not_installed': 'Excel 解析库未安装，请运行: npm install exceljs',
    'doc.wps_legacy_unsupported': '无法直接读取此 WPS 文字文件。请用 WPS 另存为 Word（.docx）后再试。',
    'doc.et_legacy_unsupported': '无法直接读取此 WPS 表格文件。请用 WPS 另存为 Excel（.xlsx）后再试。',

    // Excel 内容标注
    'doc.excel_sheet': '## 工作表: {name}',
    'doc.excel_sheet_size': '({rows} 行 x {cols} 列)',
    'doc.excel_sheet_truncated': '⚠️ 内容已截断（显示前 {maxRows} 行）',
    'doc.excel_sheet_empty': '（空工作表）',
    'doc.excel_summary': '📊 Excel 文件概览：{sheets} 个工作表，共 {rows} 行数据',

    // CSV 内容标注
    'doc.csv_truncated': '⚠️ 表格已截断（共 {rows} 行 x {cols} 列，显示 {dispRows} 行 x {dispCols} 列）',

    // generateSummary 标签
    'doc.summary_type': '- 类型: {type}',
    'doc.summary_size': '- 大小: {size}',
    'doc.summary_pages': '- 页数: {pages}',
    'doc.summary_length': '- 内容长度: {length} 字符',
    'doc.summary_error': '- ⚠️ 错误: {error}',

    // getSupportedTypes 描述
    'doc.type_pdf': 'PDF 文档',
    'doc.type_docx': 'Word 文档 (2007+)',
    'doc.type_doc': 'Word 文档 (97-2003)',
    'doc.type_xlsx': 'Excel 表格 (2007+)',
    'doc.type_xls': 'Excel 表格 (97-2003)',
    'doc.type_wps': 'WPS 文字',
    'doc.type_wpt': 'WPS 文字模板',
    'doc.type_et': 'WPS 表格',
    'doc.type_ett': 'WPS 表格模板',
    'doc.type_txt': '纯文本',
    'doc.type_md': 'Markdown',
    'doc.type_json': 'JSON',
    'doc.type_xml': 'XML',
    'doc.type_html': 'HTML',
    'doc.type_csv': 'CSV',
  },
  'en-US': {
    'doc.file_not_found': 'File not found: {path}',
    'doc.file_too_large': '[{name} is large ({size}), content skipped]',
    'doc.content_truncated': '\n\n... [Content truncated, original length: {length} characters]',
    'doc.parse_failed': 'Parse failed',

    'doc.scan_pdf_error': 'PDF has {pages} pages but no text could be extracted. The file may be a scanned or image-based PDF.',
    'doc.empty_pdf_error': 'PDF file is empty or format not supported',

    'doc.mammoth_not_installed': 'Word parser not installed, run: npm install mammoth',
    'doc.word_extractor_not_installed': 'Word (.doc) parser not installed, run: npm install word-extractor',
    'doc.exceljs_not_installed': 'Excel parser not installed, run: npm install exceljs',
    'doc.wps_legacy_unsupported': 'This WPS Writer file cannot be read directly. Please save it as Word (.docx) in WPS and try again.',
    'doc.et_legacy_unsupported': 'This WPS Spreadsheet file cannot be read directly. Please save it as Excel (.xlsx) in WPS and try again.',

    'doc.excel_sheet': '## Sheet: {name}',
    'doc.excel_sheet_size': '({rows} rows x {cols} columns)',
    'doc.excel_sheet_truncated': '⚠️ Content truncated (showing first {maxRows} rows)',
    'doc.excel_sheet_empty': '(Empty sheet)',
    'doc.excel_summary': '📊 Excel Overview: {sheets} sheets, {rows} rows total',

    'doc.csv_truncated': '⚠️ Table truncated ({rows} rows x {cols} cols, showing {dispRows} rows x {dispCols} cols)',

    'doc.summary_type': '- Type: {type}',
    'doc.summary_size': '- Size: {size}',
    'doc.summary_pages': '- Pages: {pages}',
    'doc.summary_length': '- Content length: {length} characters',
    'doc.summary_error': '- ⚠️ Error: {error}',

    'doc.type_pdf': 'PDF Document',
    'doc.type_docx': 'Word Document (2007+)',
    'doc.type_doc': 'Word Document (97-2003)',
    'doc.type_xlsx': 'Excel Spreadsheet (2007+)',
    'doc.type_xls': 'Excel Spreadsheet (97-2003)',
    'doc.type_wps': 'WPS Writer',
    'doc.type_wpt': 'WPS Writer Template',
    'doc.type_et': 'WPS Spreadsheet',
    'doc.type_ett': 'WPS Spreadsheet Template',
    'doc.type_txt': 'Plain Text',
    'doc.type_md': 'Markdown',
    'doc.type_json': 'JSON',
    'doc.type_xml': 'XML',
    'doc.type_html': 'HTML',
    'doc.type_csv': 'CSV',
  },
} as const

let cachedLocale: 'zh-CN' | 'en-US' | null = null
let configService: ConfigService | null = null

export function setConfigService(service: ConfigService): void {
  configService = service
}

export function updateLocale(locale: 'zh-CN' | 'en-US'): void {
  cachedLocale = locale
}

function getLocale(): 'zh-CN' | 'en-US' {
  if (configService) {
    const locale = configService.getLanguage()
    return locale === 'en-US' ? 'en-US' : 'zh-CN'
  }
  return cachedLocale || 'zh-CN'
}

export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const locale = getLocale()
  let text: string = translations[locale][key] || translations['zh-CN'][key] || key

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, String(v))
    }
  }

  return text
}
