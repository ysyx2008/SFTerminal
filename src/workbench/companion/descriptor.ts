import CompanionWorkbench from '../../components/workbench/CompanionWorkbench.vue'
import type { WorkbenchDescriptor } from '../types'
import { COMPANION_WORKBENCH_AGENT_PROMPT } from './prompt'

export const descriptor: WorkbenchDescriptor = {
  kind: 'companion',
  renderer: CompanionWorkbench,
  // 与 assistant 一致：助手类工作台在 Steam 版不提供，回退到终端渲染器
  availableInSteam: false,
  agentPrompt: COMPANION_WORKBENCH_AGENT_PROMPT,
}
