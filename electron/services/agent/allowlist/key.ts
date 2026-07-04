/**
 * 用户授权清单键生成（与 Agent.generateAllowedToolKey 语义一致）
 */
import type { ToolDefinition } from '../../ai.service'
import { getAgentTools } from '../tools'
import { getMetaByName } from '../tool-metadata'

let cachedTools: ToolDefinition[] | null = null

function getToolsForMeta(): ToolDefinition[] {
  cachedTools ??= getAgentTools()
  return cachedTools
}

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

/** 测试用：清缓存 */
export function resetAllowlistKeyCacheForTest(): void {
  cachedTools = null
}
