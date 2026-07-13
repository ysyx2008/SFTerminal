import CompanionWorkbench from './CompanionWorkbench.vue'
import type { WorkbenchDescriptor } from '@sailfish/workbench-sdk'
import { COMPANION_WORKBENCH_AGENT_PROMPT } from './prompt'

export const descriptor: WorkbenchDescriptor = {
  kind: 'companion',
  renderer: CompanionWorkbench,
  availableInSteam: false,
  agentPrompt: COMPANION_WORKBENCH_AGENT_PROMPT,
}
