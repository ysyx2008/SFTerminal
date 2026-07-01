import SkillWorkbench from '../../components/workbench/SkillWorkbench.vue'
import type { WorkbenchDescriptor } from '../types'

export const descriptor: WorkbenchDescriptor = {
  kind: 'skill',
  renderer: SkillWorkbench,
  // 与 assistant / companion 一致：助手类工作台在 Steam 版不提供，回退到终端渲染器
  availableInSteam: false,
}
