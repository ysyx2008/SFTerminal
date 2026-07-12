/**
 * 按 WorkbenchKind 解析 Agent system prompt 片段（→ AgentContext.workbenchPrompt）
 *
 * 真相源：已注册 WorkbenchDescriptor.agentPrompt（不再按 kind 硬编码分支）。
 */
import { getWorkbenchDescriptor } from './registry-store'
import type { WorkbenchKind, WorkbenchAgentPromptTab } from './types'

export type { WorkbenchAgentPromptTab }

export function resolveWorkbenchAgentPrompt(
  kind: WorkbenchKind,
  tab: WorkbenchAgentPromptTab
): string | undefined {
  const desc = getWorkbenchDescriptor(kind)
  const prompt = desc?.agentPrompt
  if (prompt == null) return undefined
  if (typeof prompt === 'function') {
    return prompt(tab)
  }
  return prompt
}
