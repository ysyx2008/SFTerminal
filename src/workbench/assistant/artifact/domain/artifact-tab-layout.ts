/**
 * Artifact 面板 tab 条布局：可见 tab 选取 + 溢出列表排序/过滤
 */
import type { CanvasArtifact } from '@shared/types'
import { artifactDisplayLabel } from './artifact-actions'

/** 头部直接展示的 tab 上限 */
export const ARTIFACT_VISIBLE_TAB_MAX = 4

export function sortArtifactsByRecent(artifacts: readonly CanvasArtifact[]): CanvasArtifact[] {
  return [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function pickVisibleArtifactTabs(
  artifacts: readonly CanvasArtifact[],
  activeArtifactId: string | null,
  maxVisible = ARTIFACT_VISIBLE_TAB_MAX
): { visible: CanvasArtifact[]; overflowCount: number } {
  if (artifacts.length === 0) {
    return { visible: [], overflowCount: 0 }
  }
  if (artifacts.length <= maxVisible) {
    return { visible: [...artifacts], overflowCount: 0 }
  }

  const recent = sortArtifactsByRecent(artifacts)
  const picked: CanvasArtifact[] = []
  const pickedIds = new Set<string>()

  const active = activeArtifactId
    ? artifacts.find(a => a.id === activeArtifactId)
    : null
  if (active) {
    picked.push(active)
    pickedIds.add(active.id)
  }

  for (const artifact of recent) {
    if (picked.length >= maxVisible) break
    if (pickedIds.has(artifact.id)) continue
    picked.push(artifact)
    pickedIds.add(artifact.id)
  }

  return {
    visible: picked,
    overflowCount: artifacts.length - picked.length
  }
}

export function filterArtifactsByQuery(
  artifacts: readonly CanvasArtifact[],
  query: string
): CanvasArtifact[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...artifacts]
  return artifacts.filter((a) => {
    const label = artifactDisplayLabel(a, '').toLowerCase()
    const title = (a.title || '').toLowerCase()
    const path = (a.filePath || '').toLowerCase()
    return label.includes(q) || title.includes(q) || path.includes(q)
  })
}
