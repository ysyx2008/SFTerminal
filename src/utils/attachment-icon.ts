/**
 * 聊天附件 / 上传文档的类型图标元数据（Lucide kind + 类型色）
 */

export type AttachmentIconKind =
  | 'pdf'
  | 'word'
  | 'sheet'
  | 'slides'
  | 'text'
  | 'code'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'file'

export interface AttachmentIconMeta {
  kind: AttachmentIconKind
  /** 类型强调色（跨平台一致；暗色背景下仍可辨） */
  color: string
}

function extFromName(filename?: string): string {
  if (!filename) return ''
  const base = filename.replace(/\\/g, '/').split('/').pop() || filename
  const idx = base.lastIndexOf('.')
  if (idx <= 0 || idx === base.length - 1) return ''
  return base.slice(idx + 1).toLowerCase()
}

/** 归一化为无点小写扩展名；优先 fileType，其次文件名 */
export function resolveAttachmentExt(fileType?: string, filename?: string): string {
  const fromType = (fileType || '').replace(/^\./, '').toLowerCase().trim()
  // fileType 有时是 MIME 片段或完整类型名（如 application/pdf）
  if (fromType.includes('/')) {
    const sub = fromType.split('/').pop() || ''
    if (sub === 'pdf') return 'pdf'
    if (sub.includes('word') || sub === 'msword' || sub.includes('wps-office.wps') || sub === 'kswps') return 'docx'
    if (sub.includes('sheet') || sub.includes('excel') || sub.includes('wps-office.et') || sub === 'kset') return 'xlsx'
    if (sub.includes('presentation') || sub.includes('powerpoint')) return 'pptx'
    if (sub.startsWith('image')) return 'png'
    if (sub.startsWith('audio')) return 'mp3'
    if (sub.startsWith('video')) return 'mp4'
    if (sub === 'zip' || sub === 'x-zip-compressed') return 'zip'
    return sub || extFromName(filename)
  }
  if (fromType && fromType !== 'unknown' && fromType !== 'file') return fromType
  return extFromName(filename)
}

/** 按文件类型返回 Lucide kind + 颜色 */
export function getAttachmentIconMeta(fileType?: string, filename?: string): AttachmentIconMeta {
  const ext = resolveAttachmentExt(fileType, filename)

  switch (ext) {
    case 'pdf':
      return { kind: 'pdf', color: '#ef5350' }
    case 'doc':
    case 'docx':
    case 'wps':
    case 'wpt':
      return { kind: 'word', color: '#42a5f5' }
    case 'xls':
    case 'xlsx':
    case 'csv':
    case 'et':
    case 'ett':
      return { kind: 'sheet', color: '#66bb6a' }
    case 'ppt':
    case 'pptx':
      return { kind: 'slides', color: '#ff7043' }
    case 'txt':
    case 'md':
    case 'markdown':
    case 'rtf':
      return { kind: 'text', color: '#90a4ae' }
    case 'json':
    case 'xml':
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'html':
    case 'htm':
    case 'css':
    case 'js':
    case 'ts':
    case 'jsx':
    case 'tsx':
    case 'py':
    case 'go':
    case 'rs':
    case 'java':
    case 'c':
    case 'cpp':
    case 'h':
    case 'sh':
    case 'sql':
      return { kind: 'code', color: '#ab47bc' }
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'bmp':
    case 'svg':
    case 'ico':
    case 'heic':
      return { kind: 'image', color: '#26c6da' }
    case 'mp3':
    case 'wav':
    case 'aac':
    case 'flac':
    case 'm4a':
    case 'ogg':
      return { kind: 'audio', color: '#ec407a' }
    case 'mp4':
    case 'mov':
    case 'avi':
    case 'mkv':
    case 'webm':
      return { kind: 'video', color: '#7e57c2' }
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
    case 'tgz':
      return { kind: 'archive', color: '#ffa726' }
    default:
      return { kind: 'file', color: '#9e9e9e' }
  }
}
