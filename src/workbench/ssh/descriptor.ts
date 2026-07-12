import TerminalTabView from '../../components/TerminalTabView.vue'
import type { WorkbenchDescriptor } from '../types'
import { SSH_WORKBENCH_AGENT_PROMPT } from './prompt'

export const descriptor: WorkbenchDescriptor = {
  kind: 'ssh',
  renderer: TerminalTabView,
  availableInSteam: true,
  agentPrompt: SSH_WORKBENCH_AGENT_PROMPT,
}
