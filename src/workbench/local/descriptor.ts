import TerminalTabView from '../../components/TerminalTabView.vue'
import type { WorkbenchDescriptor } from '../types'

export const descriptor: WorkbenchDescriptor = {
  kind: 'local',
  renderer: TerminalTabView,
  availableInSteam: true,
}
