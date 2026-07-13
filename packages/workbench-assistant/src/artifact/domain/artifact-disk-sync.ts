/**
 * Agent 步骤完成后触发产出物磁盘同步的规则
 *
 * 不解析 exec 命令，仅在 shell 工具落地后用 localFs.exists 复检已注册 path；
 * 移除磁盘上已不存在的锚点，不会自动发现 mv/rename 后的新路径。
 */
import type { AgentStep } from '@shared/types'

/** 可能改动磁盘文件的工具（助手模式删文件通常走 exec） */
export const DISK_SYNC_AFTER_TOOLS = new Set(['exec', 'await_exec'])

export function shouldSyncArtifactsAfterStep(step: AgentStep): boolean {
  return (
    step.type === 'tool_result' &&
    typeof step.toolName === 'string' &&
    DISK_SYNC_AFTER_TOOLS.has(step.toolName)
  )
}
