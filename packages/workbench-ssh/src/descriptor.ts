/**
 * ssh 工作台 descriptor。
 * 终端壳经 SDK 薄壳：`@sailfish/workbench-sdk/terminal-tab-view`。
 */
import { TerminalTabView } from '@sailfish/workbench-sdk/terminal-tab-view'
import type { WorkbenchDescriptor } from '@sailfish/workbench-sdk'
import { SSH_WORKBENCH_AGENT_PROMPT } from './prompt'

export const descriptor: WorkbenchDescriptor = {
  kind: 'ssh',
  renderer: TerminalTabView,
  availableInSteam: true,
  agentPrompt: SSH_WORKBENCH_AGENT_PROMPT,
}
