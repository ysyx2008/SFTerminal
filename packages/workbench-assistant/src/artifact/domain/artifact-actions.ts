/**
 * Artifact 面板保存 / 路径相关纯函数与 IPC 封装
 */
import type { CanvasArtifact } from '@shared/types'
import {
  getArtifactSaveStrategy,
  isArtifactEditable,
  saveExtensionForRenderer
} from '../renderers/registry'

export function artifactBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

export { saveExtensionForRenderer }

function fileExtensionOf(filePath: string): string {
  const base = artifactBasename(filePath)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

/** 用户可见的文件名（另存为默认名、外发文件名）：标题优先，扩展名取自物理文件 */
export function defaultSaveFileName(
  artifact: Pick<CanvasArtifact, 'title' | 'filePath' | 'renderer'>
): string {
  const ext = artifact.filePath
    ? fileExtensionOf(artifact.filePath)
    : saveExtensionForRenderer(artifact.renderer)
  const base = (
    artifact.title?.trim() ||
    (artifact.filePath ? artifactBasename(artifact.filePath) : '') ||
    'untitled'
  )
  if (ext && !base.toLowerCase().endsWith(ext.toLowerCase())) return `${base}${ext}`
  return base
}

/** tab / 下拉显示名：标题（语义名）优先，无标题时退化为物理文件名 */
export function artifactDisplayLabel(
  artifact: Pick<CanvasArtifact, 'title' | 'filePath'>,
  untitled = 'Untitled'
): string {
  return artifact.title?.trim() || (artifact.filePath ? artifactBasename(artifact.filePath) : untitled)
}

/** 覆盖原路径（可编辑且已有 filePath） */
export function canSaveArtifact(artifact: CanvasArtifact): boolean {
  return isArtifactEditable(artifact) && Boolean(artifact.filePath)
}

/** 另存为：可编辑类型任意；其它类型需已有磁盘文件 */
export function canSaveAsArtifact(artifact: CanvasArtifact): boolean {
  if (isArtifactEditable(artifact)) return true
  return Boolean(artifact.filePath)
}

export function listSaveableArtifacts(artifacts: readonly CanvasArtifact[]): CanvasArtifact[] {
  return artifacts.filter(canSaveAsArtifact)
}

export interface ArtifactSaveDeps {
  writeFile: (path: string, content: string) => Promise<{ success: boolean; error?: string }>
  copyFile: (src: string, dest: string) => Promise<{ success: boolean; error?: string }>
  selectSavePath: (defaultName: string) => Promise<{ canceled: boolean; path: string }>
  getContent: (artifactId: string) => string
}

export async function saveArtifactToPath(
  artifact: CanvasArtifact,
  content: string,
  targetPath: string,
  deps: Pick<ArtifactSaveDeps, 'writeFile' | 'copyFile'>
): Promise<{ ok: true } | { ok: false; error: string }> {
  const strategy = getArtifactSaveStrategy(artifact)
  if (strategy === 'write') {
    const res = await deps.writeFile(targetPath, content)
    return res.success ? { ok: true } : { ok: false, error: res.error || 'write failed' }
  }
  if (strategy === 'copy' && artifact.filePath) {
    const res = await deps.copyFile(artifact.filePath, targetPath)
    return res.success ? { ok: true } : { ok: false, error: res.error || 'copy failed' }
  }
  return { ok: false, error: 'no source file' }
}

export async function saveArtifact(
  artifact: CanvasArtifact,
  deps: ArtifactSaveDeps
): Promise<{ ok: true; filePath: string } | { ok: false; error: string }> {
  const path = artifact.filePath
  if (!path || !canSaveArtifact(artifact)) {
    return { ok: false, error: 'not saveable' }
  }
  const content = deps.getContent(artifact.id)
  const res = await saveArtifactToPath(artifact, content, path, deps)
  return res.ok ? { ok: true, filePath: path } : res
}

export async function saveArtifactAs(
  artifact: CanvasArtifact,
  deps: ArtifactSaveDeps
): Promise<{ ok: true; filePath: string } | { ok: false; canceled?: boolean; error?: string }> {
  if (!canSaveAsArtifact(artifact)) {
    return { ok: false, error: 'not saveable' }
  }
  const dialog = await deps.selectSavePath(defaultSaveFileName(artifact))
  if (dialog.canceled || !dialog.path) {
    return { ok: false, canceled: true }
  }
  const content = deps.getContent(artifact.id)
  const res = await saveArtifactToPath(artifact, content, dialog.path, deps)
  return res.ok ? { ok: true, filePath: dialog.path } : res
}

export interface SaveAllResult {
  saved: number
  failed: number
  errors: string[]
}

/** 将全部可保存 artifact 写入各自 filePath（可编辑类型覆盖；其它类型跳过无 path） */
export async function saveAllArtifacts(
  artifacts: readonly CanvasArtifact[],
  deps: ArtifactSaveDeps
): Promise<SaveAllResult> {
  let saved = 0
  let failed = 0
  const errors: string[] = []

  for (const artifact of artifacts) {
    if (!canSaveArtifact(artifact)) continue
    const res = await saveArtifact(artifact, deps)
    if (res.ok) {
      saved += 1
    } else if (res.error !== 'not saveable') {
      failed += 1
      errors.push(`${artifact.title || artifact.id}: ${res.error}`)
    }
  }

  return { saved, failed, errors }
}
