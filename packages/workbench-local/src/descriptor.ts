/**
 * local 工作台 descriptor。
 * TerminalTabView 仍在 desktop（Teleport 保命池），经 `@/` 引用。
 */
import TerminalTabView from '@/components/TerminalTabView.vue'
import type { WorkbenchDescriptor } from '../../../src/workbench/types'
import { LOCAL_WORKBENCH_AGENT_PROMPT } from './prompt'

export const descriptor: WorkbenchDescriptor = {
  kind: 'local',
  renderer: TerminalTabView,
  availableInSteam: true,
  agentPrompt: LOCAL_WORKBENCH_AGENT_PROMPT,
}
