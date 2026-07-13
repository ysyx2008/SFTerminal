import AssistantWorkbench from './AssistantWorkbench.vue'
import type { WorkbenchDescriptor } from '@sailfish/workbench-sdk'
import { AGENT_PROMPT, shouldInjectAgentPrompt } from './prompt'

export const descriptor: WorkbenchDescriptor = {
  kind: 'assistant',
  renderer: AssistantWorkbench,
  availableInSteam: false,
  agentPrompt: (tab) => (shouldInjectAgentPrompt(tab) ? AGENT_PROMPT : undefined),
}
