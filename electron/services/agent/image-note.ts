/**
 * 用户附带图片时写给模型的系统附注。
 * 有磁盘路径时一并告知，避免它满盘找图。
 */
import type { AttachmentInfo } from '@shared/types'
import { t } from './i18n'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

export function collectImageAttachmentPaths(attachments?: AttachmentInfo[]): string[] {
  if (!attachments?.length) return []
  const paths: string[] = []
  for (const a of attachments) {
    if (!a.filePath) continue
    const ext = (a.fileType || a.filename.split('.').pop() || '')
      .toLowerCase()
      .replace(/^\./, '')
    const looksLikeImage = IMAGE_EXTS.has(ext)
      || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filename)
      || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filePath)
    if (looksLikeImage) paths.push(a.filePath)
  }
  return paths
}

function formatPathsBlock(paths: string[]): string {
  if (paths.length === 0) return ''
  const listed = paths.length === 1
    ? paths[0]
    : paths.map((p, i) => `${i + 1}. ${p}`).join('\n')
  return t('agent.images_attached_paths', { paths: listed })
}

export function buildUserImageNote(opts: {
  count: number
  paths: string[]
  visionAvailable: boolean
}): string {
  const paths = formatPathsBlock(opts.paths)
  if (opts.visionAvailable) {
    return t('agent.images_attached', { count: opts.count, paths })
  }
  return t('agent.user_image_no_vision', { count: opts.count, paths })
}
