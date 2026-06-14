/**
 * 产出物 tab / 面板右键菜单项可见性（纯函数）
 */
import type { CanvasArtifact } from '@shared/types'
import { canSaveAsArtifact } from './artifact-actions'

export interface ArtifactContextMenuFlags {
  showSave: boolean
  showSaveAs: boolean
  showOpen: boolean
  showCloseOthers: boolean
}

export function getArtifactContextMenuFlags(
  artifact: CanvasArtifact,
  artifactCount: number,
  options: { isDirty: boolean; fileExists: boolean }
): ArtifactContextMenuFlags {
  const hasPath = Boolean(artifact.filePath)
  return {
    showSave:
      artifact.renderer === 'markdown' &&
      hasPath &&
      options.fileExists &&
      options.isDirty,
    showSaveAs: canSaveAsArtifact(artifact),
    showOpen: hasPath && options.fileExists,
    showCloseOthers: artifactCount > 1
  }
}

export function artifactHasFileActions(flags: ArtifactContextMenuFlags): boolean {
  return flags.showOpen || flags.showSave || flags.showSaveAs
}
