import AssistantWorkbench from './AssistantWorkbench.vue'
import type { WorkbenchDescriptor } from '../../../src/workbench/types'
import { AGENT_PROMPT, shouldInjectAgentPrompt } from './prompt'

export const descriptor: WorkbenchDescriptor = {
  kind: 'assistant',
  renderer: AssistantWorkbench,
  availableInSteam: false,
  agentPrompt: (tab) => (shouldInjectAgentPrompt(tab) ? AGENT_PROMPT : undefined),
}
