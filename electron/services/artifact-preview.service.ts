/**
 * 产出物面板预览重建 — 从历史/续聊恢复时按 filePath 重新生成预览 HTML
 */
import * as fs from 'fs'
import type { CanvasRendererType } from '@shared/types'
import { createLogger } from '../utils/logger'

const log = createLogger('ArtifactPreview')

const MAMMOTH_STYLE_MAP = [
  "p[style-name='Title'] => h1.document-title:fresh",
  'p.Title => h1.document-title:fresh',
  "p[style-name='Subtitle'] => h2.document-subtitle:fresh",
]

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function previewDocxHtml(filePath: string): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.convertToHtml(
    { path: filePath },
    { styleMap: MAMMOTH_STYLE_MAP }
  )
  return result.value
}

async function previewXlsxHtml(filePath: string): Promise<string> {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  const sheet = workbook.worksheets[0]
  if (!sheet || sheet.rowCount === 0) {
    return '<p><em>(空工作簿)</em></p>'
  }

  const maxRows = Math.min(sheet.rowCount, 100)
  const maxCols = Math.min(sheet.columnCount, 20)
  const rows: string[] = ['<table class="excel-preview">']

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > maxRows) return
    const cells: string[] = []
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (colNumber > maxCols) return
      const val = cell.value == null ? '' : String(cell.text ?? cell.value)
      const tag = rowNumber === 1 ? 'th' : 'td'
      cells.push(`<${tag}>${escapeHtml(val)}</${tag}>`)
    })
    if (cells.length > 0) rows.push(`<tr>${cells.join('')}</tr>`)
  })

  rows.push('</table>')
  return rows.join('\n')
}

/** 按 renderer 从磁盘文件重建产出物 preview content */
export async function previewArtifactFromFile(
  filePath: string,
  renderer: CanvasRendererType
): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  switch (renderer) {
    case 'markdown':
    case 'html':
      return fs.readFileSync(filePath, 'utf-8')
    case 'document':
      return previewDocxHtml(filePath)
    case 'spreadsheet':
      return previewXlsxHtml(filePath)
    default:
      throw new Error(`Unsupported artifact preview renderer: ${renderer}`)
  }
}

export async function tryPreviewArtifactFromFile(
  filePath: string,
  renderer: CanvasRendererType
): Promise<string | null> {
  try {
    return await previewArtifactFromFile(filePath, renderer)
  } catch (err) {
    log.warn(`Failed to preview ${renderer} from ${filePath}:`, err)
    return null
  }
}
