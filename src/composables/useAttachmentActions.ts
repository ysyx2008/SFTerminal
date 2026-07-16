/**
 * 聊天附件文件操作：打开、打开所在目录、复制路径/文件名、另存为
 *
 * 依赖已有 IPC：
 * - shell.openPath / showItemInFolder
 * - sftp.selectSavePath + localFs.copyFile（与 ArtifactPanel「另存为」同源）
 */
import { useI18n } from 'vue-i18n'
import { toast } from './useToast'

export interface AttachmentActionTarget {
  filename: string
  filePath?: string
}

function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.cssText = 'position:fixed;opacity:0;left:-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(textarea)
      return ok
    } catch {
      return false
    }
  }
}

export function useAttachmentActions() {
  const { t } = useI18n()

  async function openAttachment(target: AttachmentActionTarget): Promise<void> {
    const filePath = target.filePath
    if (!filePath) {
      toast.error(t('ai.attachmentMenu.noPath'))
      return
    }
    if (!window.electronAPI?.shell?.openPath) {
      toast.error(t('ai.attachmentMenu.openFailed'))
      return
    }
    try {
      const errorMsg = await window.electronAPI.shell.openPath(filePath)
      if (errorMsg) {
        toast.error(t('ai.attachmentMenu.openFailed'))
      }
    } catch {
      toast.error(t('ai.attachmentMenu.openFailed'))
    }
  }

  async function showInFolder(target: AttachmentActionTarget): Promise<void> {
    const filePath = target.filePath
    if (!filePath) {
      toast.error(t('ai.attachmentMenu.noPath'))
      return
    }
    if (!window.electronAPI?.shell?.showItemInFolder) {
      toast.error(t('ai.attachmentMenu.showInFolderFailed'))
      return
    }
    try {
      await window.electronAPI.shell.showItemInFolder(filePath)
    } catch {
      toast.error(t('ai.attachmentMenu.showInFolderFailed'))
    }
  }

  async function copyPath(target: AttachmentActionTarget): Promise<void> {
    const filePath = target.filePath
    if (!filePath) {
      toast.error(t('ai.attachmentMenu.noPath'))
      return
    }
    const ok = await writeClipboard(filePath)
    if (ok) toast.success(t('ai.attachmentMenu.copyPathSuccess'))
    else toast.error(t('ai.attachmentMenu.copyFailed'))
  }

  async function copyFilename(target: AttachmentActionTarget): Promise<void> {
    const name = target.filename || (target.filePath ? basename(target.filePath) : '')
    if (!name) {
      toast.error(t('ai.attachmentMenu.copyFailed'))
      return
    }
    const ok = await writeClipboard(name)
    if (ok) toast.success(t('ai.attachmentMenu.copyFilenameSuccess'))
    else toast.error(t('ai.attachmentMenu.copyFailed'))
  }

  async function saveAs(target: AttachmentActionTarget): Promise<void> {
    const filePath = target.filePath
    if (!filePath) {
      toast.error(t('ai.attachmentMenu.noPath'))
      return
    }
    const selectSavePath = window.electronAPI?.sftp?.selectSavePath
    const copyFile = window.electronAPI?.localFs?.copyFile
    if (!selectSavePath || !copyFile) {
      toast.error(t('ai.attachmentMenu.saveFailed', { error: t('ai.attachmentMenu.unsupported') }))
      return
    }
    try {
      const defaultName = target.filename || basename(filePath)
      const dialog = await selectSavePath(defaultName)
      if (dialog.canceled || !dialog.path) return
      const res = await copyFile(filePath, dialog.path)
      if (!res.success) {
        toast.error(t('ai.attachmentMenu.saveFailed', { error: res.error || '' }))
        return
      }
      toast.success(t('ai.attachmentMenu.saveSuccess', { filename: basename(dialog.path) }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(t('ai.attachmentMenu.saveFailed', { error: msg }))
    }
  }

  return {
    openAttachment,
    showInFolder,
    copyPath,
    copyFilename,
    saveAs,
  }
}
