/**
 * @sailfish/workbench-sdk（骨架）
 *
 * 当前 re-export 桌面内 `src/workbench` 核心 API。
 * P1 完整抽包时把 registry-store / types / resolve-prompt 迁入本包。
 */
export {
  registerWorkbench,
  getWorkbenchDescriptor,
  listWorkbenchDescriptors,
  resolveWorkbenchKind,
  resolveWorkbenchRenderer,
  isWorkbenchAvailable,
  resolveWorkbenchAgentPrompt,
  bootstrapWorkbenchCapabilities,
} from '../../../src/workbench/index'

export type {
  WorkbenchDescriptor,
  WorkbenchKind,
  RegionSpec,
  WorkbenchAgentPromptTab,
} from '../../../src/workbench/index'
