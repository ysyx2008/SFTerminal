/**
 * AI 输入框剪贴板粘贴分类
 * 文本优先：有实质纯文本时交给浏览器默认粘贴，忽略 Word 等附带的伴生位图
 */

export type ComposerPastePlan =
  | { kind: 'default' }
  | { kind: 'attachments'; files: File[] }

/**
 * 根据剪贴板载荷决定粘贴策略（同步，可在 preventDefault 前调用）
 */
export function planComposerPaste(event: ClipboardEvent): ComposerPastePlan {
  const dt = event.clipboardData
  if (!dt) return { kind: 'default' }

  const plainText = dt.getData('text/plain').trim()
  if (plainText.length > 0) {
    return { kind: 'default' }
  }

  const filesFromList = dt.files?.length ? Array.from(dt.files) : []
  if (filesFromList.length > 0) {
    return { kind: 'attachments', files: filesFromList }
  }

  const items = dt.items?.length ? Array.from(dt.items) : []
  const imageFiles: File[] = []
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) imageFiles.push(file)
  }
  if (imageFiles.length > 0) {
    return { kind: 'attachments', files: imageFiles }
  }

  return { kind: 'default' }
}

/**
 * 附件分流：图片进视觉区，其余进文档解析（与拖放、选择附件一致）
 */
export async function ingestComposerAttachments(
  files: FileList | File[],
  handlers: {
    ingestImages: (files: FileList | File[]) => Promise<number>
    ingestDocuments: (files: FileList | File[]) => Promise<void>
  }
): Promise<void> {
  const list = Array.from(files)
  if (list.length === 0) return
  const imageCount = await handlers.ingestImages(list)
  if (imageCount < list.length) {
    await handlers.ingestDocuments(list)
  }
}
