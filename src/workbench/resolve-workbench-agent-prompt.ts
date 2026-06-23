/**
 * 按 WorkbenchKind 解析 Agent system prompt 片段（→ AgentContext.workbenchPrompt）
 */
import type { WorkbenchKind } from './types'
import {
  AGENT_PROMPT,
  shouldInjectAgentPrompt,
  type WorkbenchAgentPromptTab
} from './assistant/prompt'
import { LOCAL_WORKBENCH_AGENT_PROMPT } from './local/prompt'
import { SSH_WORKBENCH_AGENT_PROMPT } from './ssh/prompt'
import { COMPANION_WORKBENCH_AGENT_PROMPT } from './companion/prompt'

export type { WorkbenchAgentPromptTab } from './assistant/prompt'

export function resolveWorkbenchAgentPrompt(
  kind: WorkbenchKind,
  tab: WorkbenchAgentPromptTab
): string | undefined {
  if (kind === 'assistant' && shouldInjectAgentPrompt(tab)) {
    return AGENT_PROMPT
  }
  if (kind === 'local') {
    return LOCAL_WORKBENCH_AGENT_PROMPT
  }
  if (kind === 'ssh') {
    return SSH_WORKBENCH_AGENT_PROMPT
  }
  if (kind === 'companion') {
    // 联络只含聊天区，当前无界面能力 prompt（占位为 undefined，见 companion/prompt.ts）
    return COMPANION_WORKBENCH_AGENT_PROMPT
  }
  return undefined
}
