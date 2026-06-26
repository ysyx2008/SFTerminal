/**
 * 产出物 content 读盘回填（纯函数 + 轻量 API 注入，便于单测）
 */
import type { CanvasArtifact, CanvasRendererType } from '@shared/types'

export interface ArtifactContentLoadApis {
  previewArtifact?: (
    filePath: string,
    renderer: CanvasRendererType
  ) => Promise<{ success: boolean; data?: string; error?: string }>
  readFile?: (filePath: string) => Promise<{ success: boolean; data?: string; error?: string }>
}

const PREVIEW_RENDERERS = new Set<CanvasRendererType>([
  'document',
  'spreadsheet',
  'markdown',
  'html'
])

/** 是否需要按 filePath 异步回填 content */
export function artifactNeedsContentReload(
  artifact: Pick<CanvasArtifact, 'filePath' | 'content'>
): boolean {
  return Boolean(artifact.filePath && !artifact.content?.trim())
}

/** 按 renderer 从磁盘加载产出物 content；失败返回 null */
export async function loadArtifactContentFromDisk(
  artifact: Pick<CanvasArtifact, 'filePath' | 'renderer' | 'contentFromFile'>,
  apis: ArtifactContentLoadApis
): Promise<string | null> {
  const filePath = artifact.filePath
  if (!filePath) return null

  const { previewArtifact, readFile } = apis

  if (previewArtifact && PREVIEW_RENDERERS.has(artifact.renderer)) {
    const res = await previewArtifact(filePath, artifact.renderer)
    if (res.success && typeof res.data === 'string' && res.data.trim()) {
      return res.data
    }
  }

  if (
    readFile &&
    (artifact.contentFromFile || artifact.renderer === 'html' || artifact.renderer === 'markdown')
  ) {
    const res = await readFile(filePath)
    if (res.success && typeof res.data === 'string' && res.data.trim()) {
      return res.data
    }
  }

  return null
}

/** reload 失败后的退避间隔（ms），不含首次立即尝试 */
export const ARTIFACT_CONTENT_RELOAD_DELAYS_MS = [400, 1200] as const

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
