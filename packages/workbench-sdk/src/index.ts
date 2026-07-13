/**
 * @sailfish/workbench-sdk（半成品）
 *
 * 仍 re-export 桌面内 `src/workbench` 核心 API（types / registry-store / bootstrap）。
 * 内置台 descriptor 已分别在 `@sailfish/workbench-*`；SDK 真抽待 types 迁入后再去 re-export。
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
