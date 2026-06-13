/**
 * 按 WorkbenchKind 解析 Agent UI 描述（→ AgentContext.workbenchPrompt）
 */
import type { WorkbenchKind } from './types'
import {
  AGENT_PROMPT,
  shouldInjectAgentPrompt,
  type WorkbenchAgentPromptTab
} from './assistant/prompt'

export type { WorkbenchAgentPromptTab } from './assistant/prompt'

export function resolveWorkbenchAgentPrompt(
  kind: WorkbenchKind,
  tab: WorkbenchAgentPromptTab
): string | undefined {
  if (kind === 'assistant' && shouldInjectAgentPrompt(tab)) {
    return AGENT_PROMPT
  }
  return undefined
}
