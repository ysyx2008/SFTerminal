import AssistantWorkbench from '../../components/workbench/AssistantWorkbench.vue'
import type { WorkbenchDescriptor } from '../types'

export const descriptor: WorkbenchDescriptor = {
  kind: 'assistant',
  renderer: AssistantWorkbench,
  availableInSteam: false,
}
