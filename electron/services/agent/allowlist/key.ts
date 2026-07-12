/**
 * 工具确认白名单键生成（与 Agent 会话内存 allowedTools 语义一致）
 *
 * exec 与 execute_command 共享同一条「命令」授权：命中检查会互认。
 */
import type { ToolDefinition } from '../../ai.service'
import { getAgentTools } from '../tools'
import { getMetaByName } from '../tool-metadata'

let cachedTools: ToolDefinition[] | null = null

function getToolsForMeta(): ToolDefinition[] {
  cachedTools ??= getAgentTools()
  return cachedTools
}

/** shell 命令类工具：授权按 command 互通，不区分工具名 */
const SHELL_COMMAND_TOOLS = ['execute_command', 'exec'] as const
export type ShellCommandToolName = (typeof SHELL_COMMAND_TOOLS)[number]

export function isShellCommandTool(toolName: string): toolName is ShellCommandToolName {
  return (SHELL_COMMAND_TOOLS as readonly string[]).includes(toolName)
}

/** 手动添加时写入的规范工具名 */
export const CANONICAL_SHELL_COMMAND_TOOL: ShellCommandToolName = 'execute_command'

export function extractAllowlistKeyArgs(
  toolName: string,
  toolArgs: Record<string, unknown>,
): Record<string, unknown> {
  const meta = getMetaByName(getToolsForMeta(), toolName)
  const keyFields = meta?.idempotencyKey
  if (!keyFields || keyFields.length === 0) return toolArgs
  const keyArgs: Record<string, unknown> = {}
  for (const f of keyFields) {
    keyArgs[f] = toolArgs[f]
  }
  return keyArgs
}

export function buildAllowlistKey(
  toolName: string,
  toolArgs: Record<string, unknown>,
): string {
  const keyArgs = extractAllowlistKeyArgs(toolName, toolArgs)
  return `${toolName}:${JSON.stringify(keyArgs)}`
}

/**
 * 命中检查用的候选键：shell 命令工具会同时查 exec 与 execute_command。
 */
export function buildAllowlistKeyCandidates(
  toolName: string,
  toolArgs: Record<string, unknown>,
): string[] {
  if (!isShellCommandTool(toolName)) {
    return [buildAllowlistKey(toolName, toolArgs)]
  }
  return SHELL_COMMAND_TOOLS.map(name => buildAllowlistKey(name, toolArgs))
}

/** 删除时一并清掉的兄弟键（exec ↔ execute_command） */
export function siblingAllowlistKeys(key: string): string[] {
  if (key.startsWith('execute_command:')) {
    return ['exec:' + key.slice('execute_command:'.length)]
  }
  if (key.startsWith('exec:')) {
    return ['execute_command:' + key.slice('exec:'.length)]
  }
  return []
}

/** 测试用：清缓存 */
export function resetAllowlistKeyCacheForTest(): void {
  cachedTools = null
}
