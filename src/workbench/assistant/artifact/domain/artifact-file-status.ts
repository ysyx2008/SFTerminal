/**
 * Artifact 磁盘锚点存在性检测；文件删除后从面板自动移除
 */
import type { CanvasArtifact } from '@shared/types'

export type ArtifactFilePresence = 'no-path' | 'exists' | 'missing' | 'unknown'

export async function checkFilePathExists(filePath: string): Promise<boolean> {
  const api = window.electronAPI?.localFs
  if (!api?.exists) return true
  try {
    const res = await api.exists(filePath)
    return Boolean(res.success && res.data !== false)
  } catch {
    return false
  }
}

export function artifactFilePresence(
  artifact: Pick<CanvasArtifact, 'filePath'>,
  existsMap: ReadonlyMap<string, boolean>
): ArtifactFilePresence {
  const path = artifact.filePath
  if (!path) return 'no-path'
  const exists = existsMap.get(path)
  if (exists === true) return 'exists'
  if (exists === false) return 'missing'
  return 'unknown'
}

/** 批量检测带 filePath 的 artifact，返回 path → exists */
export async function refreshFilePathExistsMap(
  artifacts: readonly CanvasArtifact[]
): Promise<Map<string, boolean>> {
  const paths = [...new Set(
    artifacts
      .map(a => a.filePath)
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
  )]
  const map = new Map<string, boolean>()
  await Promise.all(
    paths.map(async (path) => {
      map.set(path, await checkFilePathExists(path))
    })
  )
  return map
}

/** 返回 filePath 已不在磁盘的 artifact id 列表 */
export function findArtifactIdsWithMissingFiles(
  artifacts: readonly CanvasArtifact[],
  existsMap: ReadonlyMap<string, boolean>
): string[] {
  return artifacts
    .filter(a => typeof a.filePath === 'string' && a.filePath.length > 0)
    .filter(a => existsMap.get(a.filePath!) === false)
    .map(a => a.id)
}
