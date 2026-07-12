import TerminalTabView from '../../components/TerminalTabView.vue'
import type { WorkbenchDescriptor } from '../types'
import { LOCAL_WORKBENCH_AGENT_PROMPT } from './prompt'

export const descriptor: WorkbenchDescriptor = {
  kind: 'local',
  renderer: TerminalTabView,
  availableInSteam: true,
  agentPrompt: LOCAL_WORKBENCH_AGENT_PROMPT,
}
