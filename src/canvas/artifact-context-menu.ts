/**
 * 产出物 tab / 面板右键菜单项可见性（纯函数）
 */
import type { CanvasArtifact } from '@shared/types'
import { canSaveAsArtifact } from './artifact-actions'
import { isArtifactEditable } from './renderers/registry'

export interface ArtifactContextMenuFlags {
  showSave: boolean
  showSaveAs: boolean
  showOpen: boolean
  showJumpToSource: boolean
  showCloseOthers: boolean
}

export function getArtifactContextMenuFlags(
  artifact: CanvasArtifact,
  artifactCount: number,
  options: { isDirty: boolean; fileExists: boolean }
): ArtifactContextMenuFlags {
  const hasPath = Boolean(artifact.filePath)
  const editable = isArtifactEditable(artifact)
  return {
    showSave:
      editable &&
      hasPath &&
      options.fileExists &&
      options.isDirty,
    showSaveAs: canSaveAsArtifact(artifact),
    showOpen: hasPath && options.fileExists,
    showJumpToSource: Boolean(artifact.sourceStepId),
    showCloseOthers: artifactCount > 1
  }
}

export function artifactHasFileActions(flags: ArtifactContextMenuFlags): boolean {
  return flags.showOpen || flags.showSave || flags.showSaveAs
}
