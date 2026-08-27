/**
 * Agent 步骤完成后触发产出物磁盘同步的规则
 *
 * 不解析 exec 命令，仅在可能改盘的工具落地后：
 * - 用 localFs.exists 复检已注册 path，移除已不存在的锚点（不会自动发现 mv 新路径）
 * - 对只读预览类产出物从磁盘重建预览（Word / WPS / 表格）
 */
import type { AgentStep, CanvasArtifact, CanvasRendererType } from '@shared/types'

/** 可能改动磁盘文件的工具（助手模式删文件通常走 exec） */
export const DISK_SYNC_AFTER_TOOLS = new Set(['exec', 'await_exec'])

/** 可能改写已打开文件内容的工具：预览要从磁盘重建，不只是检查文件还在不在 */
export const PREVIEW_REFRESH_AFTER_TOOLS = new Set([
  'exec',
  'await_exec',
  'write_text_file',
  'edit_file',
  'word_save',
  'word_from_markdown',
  'excel_save',
  'excel_from_markdown',
  'excel_merge_template'
])

/** 预览 HTML 缓存在面板里、磁盘才是真相的只读类型 */
export const DISK_PREVIEW_RENDERERS = new Set<CanvasRendererType>([
  'document',
  'spreadsheet'
])

export function shouldSyncArtifactsAfterStep(step: AgentStep): boolean {
  return (
    step.type === 'tool_result' &&
    typeof step.toolName === 'string' &&
    DISK_SYNC_AFTER_TOOLS.has(step.toolName)
  )
}

export function shouldRefreshPreviewAfterStep(step: AgentStep): boolean {
  return (
    step.type === 'tool_result' &&
    typeof step.toolName === 'string' &&
    PREVIEW_REFRESH_AFTER_TOOLS.has(step.toolName)
  )
}

/** 已打开且有磁盘路径的只读预览：即使已有 HTML 也要从文件重建 */
export function artifactNeedsForcedPreviewRefresh(
  artifact: Pick<CanvasArtifact, 'filePath' | 'renderer'>
): boolean {
  return Boolean(artifact.filePath && DISK_PREVIEW_RENDERERS.has(artifact.renderer))
}

/** 文件修改时间没变则不必重建（避免把尚未保存的 Word 预览冲回旧文件） */
export function shouldSkipPreviewRefresh(
  previousMtime: number | undefined,
  currentMtime: number | undefined
): boolean {
  return previousMtime != null && currentMtime != null && previousMtime === currentMtime
}
