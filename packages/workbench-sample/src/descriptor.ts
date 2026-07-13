import SampleWorkbench from './SampleWorkbench.vue'
import type { WorkbenchDescriptor } from '../../../src/workbench/types'
import { SAMPLE_FAKE_MCP, SAMPLE_WORKBENCH_SKILLS } from './capabilities'
import { SAMPLE_WORKBENCH_AGENT_PROMPT } from './prompt'

export const SAMPLE_WORKBENCH_KIND = 'sample' as const

export const descriptor: WorkbenchDescriptor = {
  kind: SAMPLE_WORKBENCH_KIND,
  renderer: SampleWorkbench,
  availableInSteam: false,
  skills: [...SAMPLE_WORKBENCH_SKILLS],
  mcpServers: [SAMPLE_FAKE_MCP],
  agentPrompt: SAMPLE_WORKBENCH_AGENT_PROMPT,
}
