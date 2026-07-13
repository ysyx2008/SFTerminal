/**
 * ssh 工作台 descriptor。
 * TerminalTabView 仍在 desktop（Teleport 保命池），经 `@/` 引用。
 */
import TerminalTabView from '@/components/TerminalTabView.vue'
import type { WorkbenchDescriptor } from '../../../src/workbench/types'
import { SSH_WORKBENCH_AGENT_PROMPT } from './prompt'

export const descriptor: WorkbenchDescriptor = {
  kind: 'ssh',
  renderer: TerminalTabView,
  availableInSteam: true,
  agentPrompt: SSH_WORKBENCH_AGENT_PROMPT,
}
